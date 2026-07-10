package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/runslab/slab/go/internal/gitsrc"
	"github.com/runslab/slab/go/internal/manifest"
	"github.com/runslab/slab/go/internal/state"
)

func dispatch(cmd string, args []string) error {
	switch cmd {
	case "", "help", "--help", "-h":
		printHelp()
		return nil
	case "version", "--version", "-V":
		fmt.Printf("slab %s (%s/%s)\n", Version, runtime.GOOS, runtime.GOARCH)
		return nil
	case "create":
		return cmdCreate(args)
	case "deploy":
		return cmdDeploy(args)
	case "up":
		return cmdUp(args)
	case "run":
		return cmdRun(args)
	case "jobs":
		return cmdJobs()
	case "job":
		return cmdJob(args)
	case "list":
		return cmdList()
	case "systems":
		return cmdSystems()
	case "logs":
		return cmdLogs(args)
	case "stop", "start":
		return cmdStopStart(cmd, args)
	case "rm":
		return cmdRm(args)
	case "secret":
		return cmdSecret(args)
	case "url":
		return cmdURL(args)
	case "expose", "hide":
		return cmdExposeHide(cmd, args)
	case "system":
		return cmdSystem(args)
	case "status":
		return cmdStatus()
	case "peer":
		return cmdPeer(args)
	case "node":
		return cmdNode(args)
	case "play":
		return cmdPlay(args)
	case "init":
		return cmdInit()
	case "feedback":
		return cmdFeedback(args)
	case "upgrade":
		return cmdUpgrade()
	default:
		return fmt.Errorf("unknown command '%s' — run: slab help", cmd)
	}
}

func printHelp() {
	fmt.Print(`slab — tiny local paas (` + Version + `)

usage: slab [-N|--node <peer>] <command>

  create [source]        create an app from a source dir or git url
  deploy [source]        deploy an app (builds + starts) from a dir, git url, or app name
  up <file|dir>          deploy a system (apps wired together) from a system.toml
  run [source] -- cmd    run a job to completion (--image for a stock toolchain, -d to detach)
  jobs · job             list jobs · job logs/cancel/rm <id>
  list · systems         the rack, in text
  logs <name> [-n N]     print app logs
  stop|start|rm <name>   lifecycle
  secret set|ls <name>   manage app secrets (KEY=VALUE...)
  url <name>             print an app url
  expose|hide <name>     public https via cloudflare quick tunnel
  system rm <name>       detach a system (keeps member apps)
  status                 daemon health
  peer add|ls|rm         manage cluster peers
  node [name]|open|close|token|advertise   identity + network posture
  daemon · mcp           run the daemon / the MCP agent server
  init · feedback · upgrade · version
`)
}

func cmdCreate(args []string) error {
	arg := "."
	if len(args) > 0 {
		arg = args[0]
	}
	abs, _ := filepath.Abs(arg)
	body := map[string]any{}
	if gitsrc.LooksLikeGitURL(arg) && !isDir(abs) {
		body["gitUrl"] = arg
	} else {
		body["sourceDir"] = abs
	}
	var out struct {
		App struct {
			Name     string `json:"name"`
			Manifest struct {
				Type string `json:"type"`
			} `json:"manifest"`
		} `json:"app"`
	}
	if err := api.req("POST", "/v1/apps", body, &out); err != nil {
		return err
	}
	h, err := health()
	if err != nil {
		return err
	}
	fmt.Printf("created %s (%s) -> %s\n", out.App.Name, out.App.Manifest.Type, appURL(out.App.Name, h["proxyPort"]))
	return nil
}

func cmdDeploy(args []string) error {
	target := ""
	rest := []string{}
	for i := 0; i < len(args); i++ {
		if args[i] == "--target" && i+1 < len(args) {
			target = args[i+1]
			i++
			continue
		}
		rest = append(rest, args[i])
	}
	arg := "."
	if len(rest) > 0 {
		arg = rest[0]
	}

	// Local dir + remote node: build HERE, ship the IMAGE, run THERE. The
	// peer never needs the source, git access, or a build toolchain.
	if absArg, _ := filepath.Abs(arg); remotePeer != nil && isDir(absArg) {
		return shipDeploy(absArg)
	}

	name, err := resolveAppName(arg, target)
	if err != nil {
		return err
	}
	var out struct {
		App struct {
			Name    string  `json:"name"`
			State   string  `json:"state"`
			Version int     `json:"version"`
			Error   *string `json:"error"`
		} `json:"app"`
	}
	if err := api.req("POST", "/v1/apps/"+name+"/deploy", nil, &out); err != nil {
		return err
	}
	if out.App.State == "running" {
		h, _ := health()
		fmt.Printf("deployed %s -> %s (v%d)\n", out.App.Name, appURL(out.App.Name, h["proxyPort"]), out.App.Version)
	} else {
		msg := ""
		if out.App.Error != nil {
			msg = " — " + *out.App.Error
		}
		fmt.Printf("%s: %s%s\n", out.App.Name, out.App.State, msg)
	}
	return nil
}

func shipDeploy(dir string) error {
	m, err := manifest.Load(dir)
	if err != nil {
		return err
	}
	image := m.Image
	if image == "" {
		image = "slab/" + m.Name + ":shipped"
		fmt.Printf("building %s locally…\n", image)
		df := m.Dockerfile
		if df == "" {
			df = "Dockerfile"
		}
		build := exec.Command("docker", "build", "-t", image, "-f", filepath.Join(dir, df), dir)
		build.Env = append(os.Environ(), "DOCKER_BUILDKIT=1")
		build.Stdout, build.Stderr = os.Stdout, os.Stderr
		if err := build.Run(); err != nil {
			return fmt.Errorf("docker build failed: %w", err)
		}
		fmt.Printf("shipping %s -> %s…\n", image, remotePeerName)
		save := exec.Command("docker", "save", image)
		pipe, err := save.StdoutPipe()
		if err != nil {
			return err
		}
		if err := save.Start(); err != nil {
			return err
		}
		if err := remotePeer.reqStream("PUT", "/v1/images", pipe); err != nil {
			_ = save.Process.Kill()
			return err
		}
		if err := save.Wait(); err != nil {
			return fmt.Errorf("docker save failed: %w", err)
		}
	}
	local, _ := localAPI.req2("GET", "/v1/health")
	origin := "remote"
	if local != nil {
		if n, ok := local["node"].(string); ok {
			origin = n
		}
	}
	shipped := *m
	shipped.Image = image
	err = api.req("POST", "/v1/apps", map[string]any{"manifest": shipped, "origin": origin}, nil)
	if err != nil && !strings.Contains(err.Error(), "exists") {
		return err
	}
	var out struct {
		App struct {
			Name    string  `json:"name"`
			State   string  `json:"state"`
			Version int     `json:"version"`
			Error   *string `json:"error"`
		} `json:"app"`
	}
	if err := api.req("POST", "/v1/apps/"+m.Name+"/deploy", nil, &out); err != nil {
		return err
	}
	if out.App.State == "running" {
		h, _ := health()
		fmt.Printf("deployed %s on %s -> %s (v%d, image shipped from here)\n", out.App.Name, remotePeerName, appURL(out.App.Name, h["proxyPort"]), out.App.Version)
	} else {
		msg := ""
		if out.App.Error != nil {
			msg = " — " + *out.App.Error
		}
		fmt.Printf("%s: %s%s\n", out.App.Name, out.App.State, msg)
	}
	return nil
}

func cmdUp(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: slab up <system.toml | dir>")
	}
	abs, _ := filepath.Abs(args[0])
	sourceFile := abs
	if isDir(abs) {
		sourceFile = filepath.Join(abs, "system.toml")
	}
	var reg struct {
		System struct {
			Name string `json:"name"`
		} `json:"system"`
	}
	if err := api.req("POST", "/v1/systems", map[string]any{"sourceFile": sourceFile}, &reg); err != nil {
		return err
	}
	var dep struct {
		System struct {
			Name        string            `json:"name"`
			Members     []string          `json:"members"`
			MemberNodes map[string]string `json:"memberNodes"`
		} `json:"system"`
	}
	if err := api.req("POST", "/v1/systems/"+reg.System.Name+"/deploy", nil, &dep); err != nil {
		return err
	}
	h, _ := health()
	apps, _ := getJSON("/v1/apps")
	public := map[string]bool{}
	if list, ok := apps["apps"].([]any); ok {
		for _, a := range list {
			am := a.(map[string]any)
			if m, ok := am["manifest"].(map[string]any); ok {
				public[fmt.Sprint(am["name"])] = m["public"] != false
			}
		}
	}
	for _, name := range dep.System.Members {
		loc := "private"
		if n := dep.System.MemberNodes[name]; n != "" {
			loc = fmt.Sprintf("@ %s (via trunk)", n)
		} else if public[name] {
			loc = appURL(name, h["proxyPort"])
		}
		fmt.Printf("  %s -> %s\n", name, loc)
	}
	fmt.Printf("system %s up (%d apps)\n", dep.System.Name, len(dep.System.Members))
	return nil
}

type jobRec struct {
	ID         string   `json:"id"`
	State      string   `json:"state"`
	ExitCode   *int     `json:"exitCode"`
	Error      *string  `json:"error"`
	Image      *string  `json:"image"`
	Command    []string `json:"command"`
	CreatedAt  string   `json:"createdAt"`
	StartedAt  *string  `json:"startedAt"`
	FinishedAt *string  `json:"finishedAt"`
}

func jobRuntime(j jobRec) string {
	if j.StartedAt == nil {
		return "-"
	}
	start, err := time.Parse("2006-01-02T15:04:05.000Z", *j.StartedAt)
	if err != nil {
		return "-"
	}
	end := time.Now()
	if j.FinishedAt != nil {
		if e, err := time.Parse("2006-01-02T15:04:05.000Z", *j.FinishedAt); err == nil {
			end = e
		}
	}
	sec := int(end.Sub(start).Seconds())
	if sec < 0 {
		sec = 0
	}
	if sec < 60 {
		return fmt.Sprintf("%ds", sec)
	}
	if sec%60 == 0 {
		return fmt.Sprintf("%dm", sec/60)
	}
	return fmt.Sprintf("%dm%ds", sec/60, sec%60)
}

func jobDone(state string) bool {
	return state == "succeeded" || state == "failed" || state == "canceled" || state == "cancelled"
}

func cmdRun(args []string) error {
	image, timeout, name := "", "30m", ""
	detach := false
	var envPairs, systems, cmdArgs []string
	var src string
	i := 0
	for ; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--":
			cmdArgs = append(cmdArgs, args[i+1:]...)
			i = len(args)
		case (a == "-i" || a == "--image") && i+1 < len(args):
			image = args[i+1]
			i++
		case (a == "-e" || a == "--env") && i+1 < len(args):
			envPairs = append(envPairs, args[i+1])
			i++
		case (a == "-t" || a == "--timeout") && i+1 < len(args):
			timeout = args[i+1]
			i++
		case a == "-d" || a == "--detach":
			detach = true
		case a == "--name" && i+1 < len(args):
			name = args[i+1]
			i++
		case (a == "-s" || a == "--system") && i+1 < len(args):
			systems = append(systems, args[i+1])
			i++
		case src == "" && !strings.HasPrefix(a, "-"):
			src = a
		default:
			cmdArgs = append(cmdArgs, a)
		}
	}
	if src == "" {
		src = "."
	}
	abs, _ := filepath.Abs(src)
	if src != "." && !isDir(abs) && !gitsrc.LooksLikeGitURL(src) {
		cmdArgs = append([]string{src}, cmdArgs...)
		src = "."
		abs, _ = filepath.Abs(src)
	}
	env := map[string]string{}
	for _, pair := range envPairs {
		k, v, ok := strings.Cut(pair, "=")
		if !ok || k == "" {
			return fmt.Errorf("malformed KEY=VALUE pair: %q", pair)
		}
		env[k] = v
	}
	body := map[string]any{"command": cmdArgs, "env": env, "timeout": timeout}
	if gitsrc.LooksLikeGitURL(src) && !isDir(abs) {
		body["gitUrl"] = src
	} else {
		body["sourceDir"] = abs
	}
	if image != "" {
		body["image"] = image
	}
	if name != "" {
		body["name"] = name
	}
	if len(systems) > 0 {
		body["systems"] = systems
	}
	var out struct {
		Job jobRec `json:"job"`
	}
	if err := api.req("POST", "/v1/jobs", body, &out); err != nil {
		return err
	}
	job := out.Job
	mode := "dockerfile build"
	if job.Image != nil {
		mode = *job.Image
	}
	suffix := ""
	if len(cmdArgs) > 0 {
		suffix = " — " + strings.Join(cmdArgs, " ")
	}
	fmt.Printf("job %s — %s%s\n", job.ID, mode, suffix)
	if detach {
		return nil
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt)
	go func() {
		<-sig
		fmt.Fprintf(os.Stderr, "\ncanceling %s…\n", job.ID)
		_ = api.req("POST", "/v1/jobs/"+job.ID+"/cancel", nil, nil)
		os.Exit(130)
	}()

	lastState := job.State
	for !jobDone(job.State) {
		time.Sleep(time.Second)
		var cur struct {
			Job jobRec `json:"job"`
		}
		if err := api.req("GET", "/v1/jobs/"+job.ID, nil, &cur); err != nil {
			return err
		}
		job = cur.Job
		if job.State != lastState {
			fmt.Printf("  %s\n", job.State)
			lastState = job.State
		}
	}
	var logs string
	_ = api.req("GET", "/v1/jobs/"+job.ID+"/logs?tail=1000", nil, &logs)
	if strings.TrimSpace(logs) != "" {
		fmt.Println("\n" + strings.TrimRight(logs, "\n"))
	}
	if job.State == "succeeded" {
		fmt.Printf("\n%s succeeded in %s\n", job.ID, jobRuntime(job))
		os.Exit(0)
	}
	msg := ""
	if job.ExitCode != nil {
		msg = fmt.Sprintf(" (exit %d)", *job.ExitCode)
	}
	if job.Error != nil {
		msg += " — " + *job.Error
	}
	fmt.Fprintf(os.Stderr, "\n%s %s%s\n", job.ID, job.State, msg)
	if job.ExitCode != nil {
		os.Exit(*job.ExitCode)
	}
	os.Exit(1)
	return nil
}

func cmdJobs() error {
	var out struct {
		Jobs []jobRec `json:"jobs"`
	}
	if err := api.req("GET", "/v1/jobs", nil, &out); err != nil {
		return err
	}
	rows := [][]string{}
	for _, j := range out.Jobs {
		exit := "-"
		if j.ExitCode != nil {
			exit = strconv.Itoa(*j.ExitCode)
		}
		cmdStr := strings.Join(j.Command, " ")
		if cmdStr == "" {
			cmdStr = "(image default)"
		}
		if len(cmdStr) > 40 {
			cmdStr = cmdStr[:40]
		}
		rows = append(rows, []string{j.ID, j.State, exit, jobRuntime(j), cmdStr, relativeTime(j.CreatedAt)})
	}
	table([]string{"ID", "STATE", "EXIT", "RUNTIME", "COMMAND", "CREATED"}, rows)
	return nil
}

func cmdJob(args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: slab job logs|cancel|rm <id>")
	}
	sub, id := args[0], args[1]
	switch sub {
	case "logs":
		tail := "100"
		for i := 2; i < len(args); i++ {
			if (args[i] == "-n" || args[i] == "--tail") && i+1 < len(args) {
				tail = args[i+1]
			}
		}
		var logs string
		if err := api.req("GET", "/v1/jobs/"+id+"/logs?tail="+tail, nil, &logs); err != nil {
			return err
		}
		fmt.Println(logs)
	case "cancel":
		if err := api.req("POST", "/v1/jobs/"+id+"/cancel", nil, nil); err != nil {
			return err
		}
		fmt.Printf("canceling %s\n", id)
	case "rm":
		if err := api.req("DELETE", "/v1/jobs/"+id, nil, nil); err != nil {
			return err
		}
		fmt.Printf("removed %s\n", id)
	default:
		return fmt.Errorf("unknown job subcommand %q", sub)
	}
	return nil
}

func cmdList() error {
	apps, err := getJSON("/v1/apps")
	if err != nil {
		return err
	}
	h, err := health()
	if err != nil {
		return err
	}
	rows := [][]string{}
	if list, ok := apps["apps"].([]any); ok {
		for _, a := range list {
			am := a.(map[string]any)
			typ := ""
			if m, ok := am["manifest"].(map[string]any); ok {
				typ = fmt.Sprint(m["type"])
			}
			deployed := "-"
			if d, ok := am["deployedAt"].(string); ok {
				deployed = relativeTime(d)
			}
			rows = append(rows, []string{
				fmt.Sprint(am["name"]), typ, fmt.Sprint(am["state"]),
				appURL(fmt.Sprint(am["name"]), h["proxyPort"]), deployed,
			})
		}
	}
	table([]string{"NAME", "TYPE", "STATE", "URL", "LAST DEPLOY"}, rows)
	return nil
}

func cmdSystems() error {
	out, err := getJSON("/v1/systems")
	if err != nil {
		return err
	}
	rows := [][]string{}
	if list, ok := out["systems"].([]any); ok {
		for _, s := range list {
			sm := s.(map[string]any)
			members := []string{}
			if ms, ok := sm["members"].([]any); ok {
				for _, m := range ms {
					members = append(members, fmt.Sprint(m))
				}
			}
			wires := 0
			if ws, ok := sm["wires"].(map[string]any); ok {
				wires = len(ws)
			}
			deployed := "-"
			if d, ok := sm["deployedAt"].(string); ok {
				deployed = relativeTime(d)
			}
			rows = append(rows, []string{fmt.Sprint(sm["name"]), strings.Join(members, ","), strconv.Itoa(wires), deployed})
		}
	}
	table([]string{"NAME", "MEMBERS", "WIRES", "DEPLOYED"}, rows)
	return nil
}

func cmdLogs(args []string) error {
	tail, follow, daemon, name := "100", false, false, ""
	for i := 0; i < len(args); i++ {
		switch {
		case (args[i] == "-n" || args[i] == "--tail") && i+1 < len(args):
			tail = args[i+1]
			i++
		case args[i] == "-f" || args[i] == "--follow":
			follow = true
		case args[i] == "--daemon":
			daemon = true
		case !strings.HasPrefix(args[i], "-") && name == "":
			name = args[i]
		}
	}
	q := "tail=" + tail
	if follow {
		q += "&follow=1"
	}
	var path string
	if daemon {
		path = "/v1/logs?" + q
	} else {
		if name == "" {
			return fmt.Errorf("which app? (or use --daemon)")
		}
		path = "/v1/apps/" + name + "/logs?" + q
	}
	if !follow && !daemon {
		var logs string
		if err := api.req("GET", path, nil, &logs); err != nil {
			return err
		}
		fmt.Println(logs)
		return nil
	}
	return api.stream("GET", path, os.Stdout)
}

func cmdStopStart(verb string, args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: slab %s <name>", verb)
	}
	if err := api.req("POST", "/v1/apps/"+args[0]+"/"+verb, nil, nil); err != nil {
		return err
	}
	past := map[string]string{"stop": "stopped", "start": "started"}[verb]
	fmt.Printf("%s %s\n", past, args[0])
	return nil
}

func cmdRm(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: slab rm <name>")
	}
	if err := api.req("DELETE", "/v1/apps/"+args[0], nil, nil); err != nil {
		return err
	}
	fmt.Printf("removed %s\n", args[0])
	return nil
}

func cmdSecret(args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: slab secret set <name> KEY=VALUE...  |  slab secret ls <name>")
	}
	sub, name := args[0], args[1]
	switch sub {
	case "set":
		values := map[string]string{}
		for _, pair := range args[2:] {
			k, v, ok := strings.Cut(pair, "=")
			if !ok || k == "" {
				return fmt.Errorf("malformed KEY=VALUE pair: %q", pair)
			}
			values[k] = v
		}
		if len(values) == 0 {
			return fmt.Errorf("no KEY=VALUE pairs given")
		}
		if err := api.req("PUT", "/v1/apps/"+name+"/secrets", map[string]any{"values": values}, nil); err != nil {
			return err
		}
		keys := make([]string, 0, len(values))
		for k := range values {
			keys = append(keys, k)
		}
		fmt.Printf("set %s for %s\n", strings.Join(keys, ", "), name)
	case "ls":
		out, err := getJSON("/v1/apps/" + name + "/secrets")
		if err != nil {
			return err
		}
		if keys, ok := out["keys"].([]any); ok {
			for _, k := range keys {
				fmt.Println(k)
			}
		}
	default:
		return fmt.Errorf("unknown secret subcommand %q", sub)
	}
	return nil
}

func cmdURL(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: slab url <name>")
	}
	out, err := getJSON("/v1/apps/" + args[0])
	if err != nil {
		return err
	}
	h, _ := health()
	fmt.Println(appURL(args[0], h["proxyPort"]))
	if app, ok := out["app"].(map[string]any); ok {
		if pu, ok := app["publicUrl"].(string); ok && pu != "" {
			fmt.Println(pu)
		}
	}
	return nil
}

func cmdExposeHide(verb string, args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: slab %s <name>", verb)
	}
	var out struct {
		App struct {
			Name      string  `json:"name"`
			PublicURL *string `json:"publicUrl"`
		} `json:"app"`
	}
	if err := api.req("POST", "/v1/apps/"+args[0]+"/"+verb, nil, &out); err != nil {
		return err
	}
	if verb == "expose" && out.App.PublicURL != nil {
		fmt.Printf("exposed %s -> %s\n", out.App.Name, *out.App.PublicURL)
	} else {
		fmt.Printf("hidden %s\n", args[0])
	}
	return nil
}

func cmdSystem(args []string) error {
	if len(args) < 2 || args[0] != "rm" {
		return fmt.Errorf("usage: slab system rm <name>")
	}
	if err := api.req("DELETE", "/v1/systems/"+args[1], nil, nil); err != nil {
		return err
	}
	fmt.Printf("detached system %s (apps kept)\n", args[1])
	return nil
}

func cmdStatus() error {
	h, err := health()
	if err != nil {
		return err
	}
	apps := 0
	if a, ok := h["apps"].(float64); ok {
		apps = int(a)
	}
	plural := "s"
	if apps == 1 {
		plural = ""
	}
	fmt.Printf("daemon: %v — node %q — %d app%s, proxy :%v\n", h["status"], h["node"], apps, plural, h["proxyPort"])
	return nil
}

func cmdPeer(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: slab peer add|ls|rm")
	}
	switch args[0] {
	case "add":
		if len(args) < 3 {
			return fmt.Errorf("usage: slab peer add <name> <url> [--token <t>]")
		}
		token := ""
		for i := 3; i < len(args); i++ {
			if args[i] == "--token" && i+1 < len(args) {
				token = args[i+1]
			}
		}
		body := map[string]any{"url": args[2]}
		if token != "" {
			body["token"] = token
		}
		if err := api.req("PUT", "/v1/peers/"+args[1], body, nil); err != nil {
			return err
		}
		note := ""
		if token != "" {
			note = " (token set)"
		}
		fmt.Printf("peer %s -> %s%s\n", args[1], strings.TrimRight(args[2], "/"), note)
	case "ls":
		out, err := getJSON("/v1/peers")
		if err != nil {
			return err
		}
		list, _ := out["peers"].([]any)
		if len(list) == 0 {
			fmt.Println("no peers — add one: slab peer add <name> <url>")
			return nil
		}
		for _, p := range list {
			pm := p.(map[string]any)
			note := ""
			if t, ok := pm["token"].(string); ok && t != "" {
				note = "\t(token)"
			}
			fmt.Printf("%s\t%s%s\n", pm["name"], pm["url"], note)
		}
	case "rm":
		if len(args) < 2 {
			return fmt.Errorf("usage: slab peer rm <name>")
		}
		if err := api.req("DELETE", "/v1/peers/"+args[1], nil, nil); err != nil {
			return err
		}
		fmt.Printf("removed peer %s\n", args[1])
	default:
		return fmt.Errorf("unknown peer subcommand %q", args[0])
	}
	return nil
}

func cmdNode(args []string) error {
	sub := "name"
	if len(args) > 0 {
		sub = args[0]
	}
	switch sub {
	case "open":
		cfg := state.LoadNodeFile()
		cfg.Bind = "0.0.0.0"
		rotate := false
		for i := 1; i < len(args); i++ {
			switch {
			case args[i] == "--token" && i+1 < len(args):
				cfg.Token = args[i+1]
				i++
			case args[i] == "--rotate-token":
				rotate = true
			case args[i] == "--advertise" && i+1 < len(args):
				cfg.Advertise = args[i+1]
				i++
			}
		}
		if rotate || cfg.Token == "" {
			cfg.Token = randHex(16)
		}
		if err := state.SaveNodeFile(cfg); err != nil {
			return err
		}
		if err := restartDaemon(); err != nil {
			return err
		}
		host, _ := os.Hostname()
		fmt.Println("node open on the network (bind 0.0.0.0)")
		fmt.Printf("  dashboard: http://%s:%d/?token=%s\n", host, daemonPort(), cfg.Token)
		fmt.Printf("  peer it:   slab peer add <name> http://%s:%d --token %s\n", host, daemonPort(), cfg.Token)
		if cfg.Advertise != "" {
			fmt.Printf("  advertise: %s\n", cfg.Advertise)
		}
	case "close":
		cfg := state.LoadNodeFile()
		cfg.Bind = "127.0.0.1"
		if err := state.SaveNodeFile(cfg); err != nil {
			return err
		}
		if err := restartDaemon(); err != nil {
			return err
		}
		fmt.Println("node closed — loopback only")
	case "token":
		cfg := state.LoadNodeFile()
		rotate := len(args) > 1 && args[1] == "--rotate"
		if rotate {
			cfg.Token = randHex(16)
			if err := state.SaveNodeFile(cfg); err != nil {
				return err
			}
			if err := restartDaemon(); err != nil {
				return err
			}
			fmt.Printf("rotated — new token: %s\n", cfg.Token)
			fmt.Println("update peers that point here: slab peer add <name> <url> --token <new>")
		} else if cfg.Token != "" {
			fmt.Println(cfg.Token)
		} else {
			fmt.Println("(no token set — slab node open creates one)")
		}
	case "advertise":
		if len(args) < 2 {
			return fmt.Errorf("usage: slab node advertise <host>")
		}
		cfg := state.LoadNodeFile()
		cfg.Advertise = args[1]
		if err := state.SaveNodeFile(cfg); err != nil {
			return err
		}
		if err := restartDaemon(); err != nil {
			return err
		}
		fmt.Printf("advertise -> %s\n", args[1])
	default: // name (print or set)
		name := sub
		if name == "name" {
			if len(args) > 1 {
				name = args[1]
			} else {
				h, err := health()
				if err != nil {
					return err
				}
				fmt.Println(h["node"])
				return nil
			}
		}
		var out map[string]any
		if err := api.req("PUT", "/v1/node", map[string]any{"name": name}, &out); err != nil {
			return err
		}
		fmt.Printf("node is now %q\n", out["node"])
	}
	return nil
}

func cmdPlay(args []string) error {
	seconds := 45
	if len(args) > 0 {
		if n, err := strconv.Atoi(args[0]); err == nil {
			seconds = n
		}
	}
	if err := api.req("POST", "/v1/play", map[string]any{"seconds": seconds}, nil); err != nil {
		return fmt.Errorf("this daemon doesn't support play yet (%s)", err.Error())
	}
	fmt.Println("playing — open the dashboard and turn the listen knob")
	return nil
}

func cmdInit() error {
	dir, _ := os.Getwd()
	file := filepath.Join(dir, "slab.toml")
	if _, err := os.Stat(file); err == nil {
		return fmt.Errorf("slab.toml already exists in %s", dir)
	}
	name := sanitize(filepath.Base(dir))
	toml := fmt.Sprintf("name = %q\ntype = \"service\"\nport = 3000\n", name)
	if err := os.WriteFile(file, []byte(toml), 0o644); err != nil {
		return err
	}
	fmt.Printf("wrote %s\n", file)
	fmt.Println("edit: name, type (service|function), port, and add a Dockerfile (or set image = \"...\")")
	return nil
}

func cmdFeedback(args []string) error {
	title := strings.Join(args, " ")
	if len(title) > 120 {
		title = title[:120]
	}
	body := fmt.Sprintf("\n\n---\nslab %s · %s/%s", Version, runtime.GOOS, runtime.GOARCH)
	if title == "" {
		body = "<!-- what happened, what you expected -->" + body
	}
	u := fmt.Sprintf("https://github.com/runslab/slab/issues/new?title=%s&body=%s", queryEscape(title), queryEscape(body))
	openInBrowser(u)
	fmt.Println("opening a prefilled issue — or paste this url:")
	fmt.Println(u)
	return nil
}

// cmdUpgrade: source installs rebuild in place; binary installs pull the
// latest GitHub release for this platform and replace the executable.
func cmdUpgrade() error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	if root := gitCheckoutRoot(self); root != "" {
		fmt.Printf("upgrading source checkout %s…\n", root)
		for _, c := range [][]string{{"git", "pull", "--ff-only"}, {"go", "build", "-o", "bin/slab", "./cmd/slab"}} {
			cmd := exec.Command(c[0], c[1:]...)
			cmd.Dir = root
			if c[0] == "go" {
				cmd.Dir = filepath.Join(root, "go")
			}
			cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
			if err := cmd.Run(); err != nil {
				return err
			}
		}
		return restartDaemon()
	}

	fmt.Println("checking the latest release…")
	resp, err := http.Get("https://api.github.com/repos/runslab/slab/releases/latest")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var rel struct {
		TagName string `json:"tag_name"`
		Assets  []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return err
	}
	want := fmt.Sprintf("slab_%s_%s.tar.gz", runtime.GOOS, runtime.GOARCH)
	assetURL := ""
	for _, a := range rel.Assets {
		if a.Name == want {
			assetURL = a.URL
		}
	}
	if assetURL == "" {
		return fmt.Errorf("no %s asset on release %s", want, rel.TagName)
	}
	if strings.Contains(Version, strings.TrimPrefix(rel.TagName, "v")) {
		fmt.Printf("already on %s\n", rel.TagName)
		return nil
	}
	fmt.Printf("downloading %s %s…\n", rel.TagName, want)
	tmp, err := os.MkdirTemp("", "slab-upgrade-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	tarball := filepath.Join(tmp, want)
	outF, err := os.Create(tarball)
	if err != nil {
		return err
	}
	dl, err := http.Get(assetURL)
	if err != nil {
		return err
	}
	defer dl.Body.Close()
	if _, err := io.Copy(outF, dl.Body); err != nil {
		return err
	}
	outF.Close()
	if err := exec.Command("tar", "-xzf", tarball, "-C", tmp).Run(); err != nil {
		return err
	}
	newBin := filepath.Join(tmp, "slab")
	if err := os.Chmod(newBin, 0o755); err != nil {
		return err
	}
	if err := os.Rename(newBin, self); err != nil {
		return fmt.Errorf("cannot replace %s (%s) — move it manually", self, err.Error())
	}
	fmt.Printf("upgraded to %s — restarting daemon…\n", rel.TagName)
	return restartDaemon()
}

func gitCheckoutRoot(self string) string {
	dir := filepath.Dir(self)
	for i := 0; i < 4; i++ {
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			if _, err := os.Stat(filepath.Join(dir, "go", "cmd", "slab")); err == nil {
				return dir
			}
		}
		dir = filepath.Dir(dir)
	}
	return ""
}

func sanitize(raw string) string {
	name := strings.ToLower(raw)
	var b strings.Builder
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			b.WriteRune(r)
		} else {
			b.WriteRune('-')
		}
	}
	name = strings.Trim(b.String(), "-")
	if name == "" || name[0] < 'a' || name[0] > 'z' {
		name = "app-" + name
	}
	if len(name) > 31 {
		name = name[:31]
	}
	for len(name) < 2 {
		name += "0"
	}
	return name
}

func randHex(n int) string {
	const chars = "0123456789abcdef"
	b := make([]byte, n*2)
	f, err := os.Open("/dev/urandom")
	if err == nil {
		raw := make([]byte, n)
		_, _ = io.ReadFull(f, raw)
		f.Close()
		for i, v := range raw {
			b[i*2] = chars[v>>4]
			b[i*2+1] = chars[v&0xf]
		}
		return string(b)
	}
	return fmt.Sprintf("%x", time.Now().UnixNano())
}

var _ = syscall.Kill // referenced from cli.go
