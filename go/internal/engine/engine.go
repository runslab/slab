// Package engine is every docker touch — the Go twin of src/engine.ts.
// Containers are named slab-<app> and labeled slab.app=<app>; named volumes
// are namespaced slab-<app>-<name> and kept on remove.
package engine

import (
	"archive/tar"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/docker/docker/api/types/build"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
	"github.com/docker/go-connections/nat"

	"github.com/runslab/slab/go/internal/state"
)

type Engine struct {
	cli *client.Client
}

func New() (*Engine, error) {
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		return nil, err
	}
	return &Engine{cli: cli}, nil
}

func containerName(app string) string { return "slab-" + app }

// EnsureImage pulls the image if it isn't present locally.
func (e *Engine) EnsureImage(ctx context.Context, ref string) error {
	if _, err := e.cli.ImageInspect(ctx, ref); err == nil {
		return nil
	}
	rc, err := e.cli.ImagePull(ctx, ref, image.PullOptions{})
	if err != nil {
		return fmt.Errorf("failed to pull %s: %w", ref, err)
	}
	defer rc.Close()
	_, err = io.Copy(io.Discard, rc) // drain: pull completes when the stream ends
	return err
}

// RemoveExisting stops and force-removes every container labeled for the app.
func (e *Engine) RemoveExisting(ctx context.Context, app string) error {
	list, err := e.cli.ContainerList(ctx, container.ListOptions{
		All:     true,
		Filters: filters.NewArgs(filters.Arg("label", "slab.app="+app)),
	})
	if err != nil {
		return err
	}
	stopT := 5
	for _, c := range list {
		_ = e.cli.ContainerStop(ctx, c.ID, container.StopOptions{Timeout: &stopT})
		if err := e.cli.ContainerRemove(ctx, c.ID, container.RemoveOptions{Force: true}); err != nil {
			return err
		}
	}
	return nil
}

type RunOpts struct {
	Publish  bool
	Volumes  []string // manifest form "name:/path"; namespaced here
	Networks []string // system networks; joined with the app name as alias
}

// EnsureNetwork creates a bridge network if it doesn't exist.
func (e *Engine) EnsureNetwork(ctx context.Context, name string) error {
	if _, err := e.cli.NetworkInspect(ctx, name, network.InspectOptions{}); err == nil {
		return nil
	}
	_, err := e.cli.NetworkCreate(ctx, name, network.CreateOptions{Driver: "bridge"})
	return err
}

// RemoveNetwork tears a system network down (ignore-if-absent).
func (e *Engine) RemoveNetwork(ctx context.Context, name string) {
	_ = e.cli.NetworkRemove(ctx, name)
}

// RunContainer removes any prior container and creates + starts a fresh one —
// the same recreate-on-every-deploy semantics as the TS engine.
func (e *Engine) RunContainer(ctx context.Context, app *state.AppRecord, imageTag string, env map[string]string, opts RunOpts) (string, error) {
	if opts.Publish && app.HostPort == nil {
		return "", fmt.Errorf("app %s has no hostPort allocated", app.Name)
	}
	if err := e.RemoveExisting(ctx, app.Name); err != nil {
		return "", err
	}

	envList := make([]string, 0, len(env))
	for k, v := range env {
		envList = append(envList, k+"="+v)
	}
	portKey := nat.Port(fmt.Sprintf("%d/tcp", app.Manifest.Port))

	cfg := &container.Config{
		Image:  imageTag,
		Env:    envList,
		Labels: map[string]string{"slab.app": app.Name},
	}
	host := &container.HostConfig{}
	if opts.Publish {
		cfg.ExposedPorts = nat.PortSet{portKey: struct{}{}}
		host.PortBindings = nat.PortMap{portKey: []nat.PortBinding{{HostIP: "127.0.0.1", HostPort: fmt.Sprint(*app.HostPort)}}}
	}
	restart := "no"
	if app.Manifest.Type == "service" {
		restart = "unless-stopped"
	}
	host.RestartPolicy = container.RestartPolicy{Name: container.RestartPolicyMode(restart)}
	for _, v := range opts.Volumes {
		host.Binds = append(host.Binds, fmt.Sprintf("slab-%s-%s", app.Name, v))
	}

	created, err := e.cli.ContainerCreate(ctx, cfg, host, nil, nil, containerName(app.Name))
	if err != nil {
		return "", fmt.Errorf("failed to create container for %s: %w", app.Name, err)
	}
	// join system networks BEFORE start — members resolve each other by app
	// name (network alias), and the app may dial a mate the moment it boots
	for _, net := range opts.Networks {
		err := e.cli.NetworkConnect(ctx, net, created.ID, &network.EndpointSettings{Aliases: []string{app.Name}})
		if err != nil {
			return "", fmt.Errorf("failed to join %s to network %s: %w", app.Name, net, err)
		}
	}
	if err := e.cli.ContainerStart(ctx, created.ID, container.StartOptions{}); err != nil {
		return "", fmt.Errorf("failed to start %s: %w", app.Name, err)
	}
	return created.ID, nil
}

// BuildImage builds the source's Dockerfile into <tag>. It prefers the
// docker CLI (BuildKit: modern Dockerfiles use RUN --mount and
// FROM --platform=$BUILDPLATFORM, which the API's legacy builder can't run)
// and falls back to the SDK tar-stream path when no CLI is present.
func (e *Engine) BuildImage(ctx context.Context, sourceDir, tag string, dockerfile string) error {
	if dockerfile == "" {
		dockerfile = "Dockerfile"
	}
	if _, err := exec.LookPath("docker"); err == nil {
		cmd := exec.CommandContext(ctx, "docker", "build", "-t", tag, "-f", filepath.Join(sourceDir, dockerfile), sourceDir)
		cmd.Env = append(os.Environ(), "DOCKER_BUILDKIT=1")
		out, err := cmd.CombinedOutput()
		if err != nil {
			lines := strings.Split(strings.TrimSpace(string(out)), "\n")
			from := len(lines) - 6
			if from < 0 {
				from = 0
			}
			return fmt.Errorf("build failed: %s", strings.Join(lines[from:], " | "))
		}
		return nil
	}
	pr, pw := io.Pipe()
	go func() { pw.CloseWithError(tarDir(sourceDir, pw)) }()
	resp, err := e.cli.ImageBuild(ctx, pr, build.ImageBuildOptions{
		Tags: []string{tag}, Remove: true, Dockerfile: dockerfile,
	})
	if err != nil {
		return fmt.Errorf("build failed for %s: %w", tag, err)
	}
	defer resp.Body.Close()
	// the build stream reports errors as JSON lines — surface them
	dec := json.NewDecoder(resp.Body)
	for {
		var msg struct {
			Error string `json:"error"`
		}
		if err := dec.Decode(&msg); err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
		if msg.Error != "" {
			return fmt.Errorf("build failed: %s", msg.Error)
		}
	}
}

// tarDir streams a directory as an uncompressed tar (the docker build context).
func tarDir(dir string, w io.Writer) error {
	tw := tar.NewWriter(w)
	defer tw.Close()
	return filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		hdr, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		hdr.Name = filepath.ToSlash(rel)
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = io.Copy(tw, f)
		return err
	})
}

func (e *Engine) Stop(ctx context.Context, app string) error {
	t := 5
	return e.cli.ContainerStop(ctx, containerName(app), container.StopOptions{Timeout: &t})
}

func (e *Engine) Start(ctx context.Context, app string) error {
	return e.cli.ContainerStart(ctx, containerName(app), container.StartOptions{})
}

// Logs returns the last <tail> lines of stdout+stderr, demuxed to plain text.
func (e *Engine) Logs(ctx context.Context, app string, tail int) (string, error) {
	rc, err := e.cli.ContainerLogs(ctx, containerName(app), container.LogsOptions{
		ShowStdout: true, ShowStderr: true, Tail: fmt.Sprint(tail), Timestamps: true,
	})
	if err != nil {
		return "", err
	}
	defer rc.Close()
	raw, err := io.ReadAll(rc)
	if err != nil {
		return "", err
	}
	return demux(raw), nil
}

// demux strips the 8-byte docker stream frame headers from multiplexed logs.
func demux(raw []byte) string {
	var sb strings.Builder
	for len(raw) >= 8 {
		size := int(raw[4])<<24 | int(raw[5])<<16 | int(raw[6])<<8 | int(raw[7])
		if size < 0 || 8+size > len(raw) {
			break
		}
		sb.Write(raw[8 : 8+size])
		raw = raw[8+size:]
	}
	if sb.Len() == 0 {
		return string(raw) // tty containers aren't multiplexed
	}
	return sb.String()
}

// RunJob creates and starts a one-shot container: slab-job-<id>, labeled,
// no restart policy, networks joined BEFORE start (a fast job would race
// the DNS setup otherwise). Returns the container id.
// workspace, when set, is a host dir bind-mounted at /workspace (image-mode
// source jobs); the container also starts there.
func (e *Engine) RunJob(ctx context.Context, id string, imageTag string, command []string, env map[string]string, networks []string, workspace string) (string, error) {
	// a crashed prior daemon could have left a container for this id behind
	list, _ := e.cli.ContainerList(ctx, container.ListOptions{
		All: true, Filters: filters.NewArgs(filters.Arg("label", "slab.job="+id)),
	})
	for _, c := range list {
		_ = e.cli.ContainerRemove(ctx, c.ID, container.RemoveOptions{Force: true})
	}

	envList := make([]string, 0, len(env))
	for k, v := range env {
		envList = append(envList, k+"="+v)
	}
	cfg := &container.Config{Image: imageTag, Env: envList, Labels: map[string]string{"slab.job": id}}
	if len(command) > 0 {
		cfg.Cmd = command
	}
	host := &container.HostConfig{RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyDisabled}}
	if workspace != "" {
		cfg.WorkingDir = "/workspace"
		host.Binds = []string{workspace + ":/workspace"}
	}
	created, err := e.cli.ContainerCreate(ctx, cfg, host, nil, nil, "slab-job-"+id)
	if err != nil {
		return "", fmt.Errorf("failed to create container for job %s: %w", id, err)
	}
	for _, net := range networks {
		if err := e.cli.NetworkConnect(ctx, net, created.ID, &network.EndpointSettings{}); err != nil {
			_ = e.cli.ContainerRemove(ctx, created.ID, container.RemoveOptions{Force: true})
			return "", fmt.Errorf("failed to join job %s to network %s: %w", id, net, err)
		}
	}
	if err := e.cli.ContainerStart(ctx, created.ID, container.StartOptions{}); err != nil {
		_ = e.cli.ContainerRemove(ctx, created.ID, container.RemoveOptions{Force: true})
		return "", fmt.Errorf("failed to start job %s: %w", id, err)
	}
	return created.ID, nil
}

// WaitJob blocks until the container exits and returns its status code.
func (e *Engine) WaitJob(ctx context.Context, containerID string) (int, error) {
	waitC, errC := e.cli.ContainerWait(ctx, containerID, container.WaitConditionNotRunning)
	select {
	case res := <-waitC:
		return int(res.StatusCode), nil
	case err := <-errC:
		return -1, err
	case <-ctx.Done():
		return -1, ctx.Err()
	}
}

// KillContainer force-stops a container by id (timeout enforcement, cancel).
func (e *Engine) KillContainer(ctx context.Context, containerID string) error {
	return e.cli.ContainerKill(ctx, containerID, "KILL")
}

// RemoveContainerByID force-removes a container.
func (e *Engine) RemoveContainerByID(ctx context.Context, containerID string) error {
	return e.cli.ContainerRemove(ctx, containerID, container.RemoveOptions{Force: true})
}

// ContainerLogsByID returns demuxed logs for a raw container id.
func (e *Engine) ContainerLogsByID(ctx context.Context, containerID string, tail int) (string, error) {
	rc, err := e.cli.ContainerLogs(ctx, containerID, container.LogsOptions{
		ShowStdout: true, ShowStderr: true, Tail: fmt.Sprint(tail),
	})
	if err != nil {
		return "", err
	}
	defer rc.Close()
	raw, err := io.ReadAll(rc)
	if err != nil {
		return "", err
	}
	return demux(raw), nil
}

// ── shared postgres (postgres = true) ──────────────────────────────────────
// SLAB_PG_PORT namespaces per daemon, mirroring the TS engine.

func pgPort() int {
	if v := os.Getenv("SLAB_PG_PORT"); v != "" {
		var p int
		if _, err := fmt.Sscanf(v, "%d", &p); err == nil {
			return p
		}
	}
	return 20432
}

func pgContainer() string {
	if os.Getenv("SLAB_PG_PORT") != "" {
		return fmt.Sprintf("slab-postgres-%d", pgPort())
	}
	return "slab-postgres"
}

func pgVolume() string {
	if os.Getenv("SLAB_PG_PORT") != "" {
		return fmt.Sprintf("slab-pgdata-%d", pgPort())
	}
	return "slab-pgdata"
}

// EnsurePostgres provisions the shared postgres container and a per-app
// database; returns the DATABASE_URL to inject.
func (e *Engine) EnsurePostgres(ctx context.Context, appName string) (string, error) {
	name := pgContainer()
	info, err := e.cli.ContainerInspect(ctx, name)
	if err != nil { // no container yet — create it
		if err := e.EnsureImage(ctx, "postgres:16-alpine"); err != nil {
			return "", err
		}
		portKey := nat.Port("5432/tcp")
		created, err := e.cli.ContainerCreate(ctx,
			&container.Config{
				Image:        "postgres:16-alpine",
				Labels:       map[string]string{"slab.system": "postgres"},
				Env:          []string{"POSTGRES_PASSWORD=slab", "POSTGRES_USER=slab"},
				ExposedPorts: nat.PortSet{portKey: struct{}{}},
			},
			&container.HostConfig{
				Binds:         []string{pgVolume() + ":/var/lib/postgresql/data"},
				PortBindings:  nat.PortMap{portKey: []nat.PortBinding{{HostIP: "127.0.0.1", HostPort: fmt.Sprint(pgPort())}}},
				RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyUnlessStopped},
			}, nil, nil, name)
		if err != nil {
			return "", fmt.Errorf("failed to create %s: %w", name, err)
		}
		if err := e.cli.ContainerStart(ctx, created.ID, container.StartOptions{}); err != nil {
			return "", fmt.Errorf("failed to start %s: %w", name, err)
		}
	} else if info.State == nil || !info.State.Running {
		if err := e.cli.ContainerStart(ctx, name, container.StartOptions{}); err != nil {
			return "", fmt.Errorf("failed to start %s: %w", name, err)
		}
	}

	// wait for readiness (pg_isready), up to 30s
	deadline := time.Now().Add(30 * time.Second)
	for {
		code, _, _ := e.execIn(ctx, name, []string{"pg_isready", "-U", "slab"})
		if code == 0 {
			break
		}
		if time.Now().After(deadline) {
			return "", fmt.Errorf("postgres did not become ready within 30s")
		}
		time.Sleep(500 * time.Millisecond)
	}

	dbName := "slab_" + strings.ReplaceAll(appName, "-", "_")
	code, out, err := e.execIn(ctx, name, []string{"psql", "-U", "slab", "-tAc",
		fmt.Sprintf("SELECT 1 FROM pg_database WHERE datname='%s'", dbName)})
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(out) != "1" {
		code, out, err = e.execIn(ctx, name, []string{"psql", "-U", "slab", "-c", "CREATE DATABASE " + dbName})
		if err != nil || (code != 0 && !strings.Contains(strings.ToLower(out), "already exists")) {
			return "", fmt.Errorf("failed to create database %s: %s", dbName, strings.TrimSpace(out))
		}
	}
	return fmt.Sprintf("postgresql://slab:slab@host.docker.internal:%d/%s", pgPort(), dbName), nil
}

// execIn runs a command inside a container and returns (exitCode, output).
func (e *Engine) execIn(ctx context.Context, containerName string, cmd []string) (int, string, error) {
	exec, err := e.cli.ContainerExecCreate(ctx, containerName, container.ExecOptions{
		Cmd: cmd, AttachStdout: true, AttachStderr: true,
	})
	if err != nil {
		return -1, "", err
	}
	att, err := e.cli.ContainerExecAttach(ctx, exec.ID, container.ExecAttachOptions{})
	if err != nil {
		return -1, "", err
	}
	defer att.Close()
	raw, _ := io.ReadAll(att.Reader)
	insp, err := e.cli.ContainerExecInspect(ctx, exec.ID)
	if err != nil {
		return -1, "", err
	}
	return insp.ExitCode, demux(raw), nil
}

// IsRunning reports whether the app's container is currently running.
func (e *Engine) IsRunning(ctx context.Context, app string) bool {
	info, err := e.cli.ContainerInspect(ctx, containerName(app))
	return err == nil && info.State != nil && info.State.Running
}
func (e *Engine) WaitReady(ctx context.Context, app string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		info, err := e.cli.ContainerInspect(ctx, containerName(app))
		if err == nil && info.State != nil && info.State.Running {
			return nil
		}
		time.Sleep(300 * time.Millisecond)
	}
	return fmt.Errorf("container for %s did not reach running", app)
}
