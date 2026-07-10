// Package gitsrc resolves git-sourced apps — the Go twin of src/git.ts.
// Clones land in SLAB_DIR/repos/<name> and are pulled on every redeploy.
package gitsrc

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/runslab/slab/go/internal/state"
)

var urlRe = regexp.MustCompile(`^(https?://|git@|file://)`)
var shorthandRe = regexp.MustCompile(`^[\w.-]+/[\w.-]+$`)
var dirCleanRe = regexp.MustCompile(`[^a-z0-9-]`)

func reposDir() string { return filepath.Join(state.Dir(), "repos") }

// LooksLikeGitURL mirrors the TS heuristic: real URL schemes, or an
// owner/repo shorthand that isn't a local path.
func LooksLikeGitURL(s string) bool {
	if urlRe.MatchString(s) {
		return true
	}
	if shorthandRe.MatchString(s) {
		if _, err := os.Stat(s); err != nil {
			return true
		}
	}
	return false
}

// NormalizeGitURL expands "owner/repo" shorthand to a github https URL.
func NormalizeGitURL(s string) string {
	if shorthandRe.MatchString(s) {
		return "https://github.com/" + s + ".git"
	}
	return s
}

// RepoDirName derives the checkout dir: last path segment, sans .git.
func RepoDirName(gitURL string) string {
	base := strings.TrimRight(gitURL, "/")
	if i := strings.LastIndex(base, "/"); i >= 0 {
		base = base[i+1:]
	}
	base = strings.TrimSuffix(base, ".git")
	return dirCleanRe.ReplaceAllString(strings.ToLower(base), "-")
}

func git(dir string, args ...string) error {
	cmd := exec.Command("git", args...)
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = err.Error()
		}
		return fmt.Errorf("git %s failed: %s", args[0], msg)
	}
	return nil
}

// CloneOrPull clones the repo (depth 1) or fast-forwards an existing
// checkout, returning the local path.
func CloneOrPull(gitURL, dirName string) (string, error) {
	if err := os.MkdirAll(reposDir(), 0o755); err != nil {
		return "", err
	}
	dest := filepath.Join(reposDir(), dirName)
	if _, err := os.Stat(filepath.Join(dest, ".git")); err == nil {
		if err := git(dest, "pull", "--ff-only"); err != nil {
			return "", err
		}
		return dest, nil
	}
	done := make(chan error, 1)
	go func() { done <- git("", "clone", "--depth", "1", gitURL, dest) }()
	select {
	case err := <-done:
		if err != nil {
			return "", err
		}
		return dest, nil
	case <-time.After(120 * time.Second):
		return "", fmt.Errorf("git clone timed out for %s", gitURL)
	}
}

// Resolve turns any source input (path, git URL, owner/repo shorthand) into
// a local sourceDir plus the gitUrl when it was a clone.
func Resolve(source, baseDir string) (sourceDir string, gitURL *string, err error) {
	asPath := source
	if !filepath.IsAbs(asPath) {
		asPath = filepath.Join(baseDir, asPath)
	}
	if _, statErr := os.Stat(asPath); statErr == nil {
		return asPath, nil, nil
	}
	if LooksLikeGitURL(source) {
		u := NormalizeGitURL(source)
		dir, cloneErr := CloneOrPull(u, RepoDirName(u))
		if cloneErr != nil {
			return "", nil, cloneErr
		}
		return dir, &u, nil
	}
	return "", nil, fmt.Errorf("cannot resolve app source %q — no directory at %s and it does not look like a git URL", source, asPath)
}
