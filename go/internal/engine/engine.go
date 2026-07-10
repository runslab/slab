// Package engine is every docker touch — the Go twin of src/engine.ts.
// Containers are named slab-<app> and labeled slab.app=<app>; named volumes
// are namespaced slab-<app>-<name> and kept on remove.
package engine

import (
	"context"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
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
	Publish bool
	Volumes []string // manifest form "name:/path"; namespaced here
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
	if err := e.cli.ContainerStart(ctx, created.ID, container.StartOptions{}); err != nil {
		return "", fmt.Errorf("failed to start %s: %w", app.Name, err)
	}
	return created.ID, nil
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

// WaitReady polls the container until it reports running (or errors out).
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
