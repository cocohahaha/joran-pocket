package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// launchd integration: install helper as a user LaunchAgent so it starts
// at login and respawns automatically if it crashes. No admin rights
// needed — it lives in ~/Library/LaunchAgents.

const launchAgentLabel = "com.joranpocket.helper"

func launchAgentPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents", launchAgentLabel+".plist")
}

func writeLaunchAgent(signalingURL, pwaURL string) error {
	home, _ := os.UserHomeDir()
	self, err := os.Executable()
	if err != nil {
		return err
	}
	logDir := pocketDir()
	body := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>%s</string>
  <key>ProgramArguments</key>
  <array>
    <string>%s</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>POCKET_SIGNALING</key><string>%s</string>
    <key>POCKET_PWA_URL</key><string>%s</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>%s</string>
    <key>LANG</key><string>en_US.UTF-8</string>
    <key>LC_ALL</key><string>en_US.UTF-8</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>%s/helper.log</string>
  <key>StandardErrorPath</key><string>%s/helper.err</string>
</dict>
</plist>
`, launchAgentLabel, self, signalingURL, pwaURL, home, logDir, logDir)
	path := launchAgentPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(body), 0o644)
}

func uidTarget() string {
	return fmt.Sprintf("gui/%d", os.Getuid())
}

func installLaunchAgent(signalingURL, pwaURL string) error {
	if err := writeLaunchAgent(signalingURL, pwaURL); err != nil {
		return err
	}
	// Best-effort unload in case an old plist is already loaded, so the
	// updated one takes effect. Tolerate all errors here.
	_ = exec.Command("launchctl", "bootout", uidTarget(), launchAgentPath()).Run()
	_ = exec.Command("launchctl", "unload", launchAgentPath()).Run()

	// Modern API first; fall back to legacy `load` on older macOS.
	if err := exec.Command("launchctl", "bootstrap", uidTarget(), launchAgentPath()).Run(); err != nil {
		if err2 := exec.Command("launchctl", "load", launchAgentPath()).Run(); err2 != nil {
			return fmt.Errorf("launchctl bootstrap: %v / load: %v", err, err2)
		}
	}
	return nil
}

func uninstallLaunchAgent() error {
	_ = exec.Command("launchctl", "bootout", uidTarget(), launchAgentPath()).Run()
	_ = exec.Command("launchctl", "unload", launchAgentPath()).Run()
	err := os.Remove(launchAgentPath())
	if err != nil && os.IsNotExist(err) {
		return nil
	}
	return err
}

func launchAgentInstalled() bool {
	_, err := os.Stat(launchAgentPath())
	return err == nil
}

// helperRunning returns true if there's a pocket helper process alive
// other than ourselves. Checks via pgrep against the helper binary path
// so subcommand invocations (which also run `pocket`) aren't counted.
func helperRunning() bool {
	self, err := os.Executable()
	if err != nil {
		return false
	}
	// -x matches exact command; without -f, matches process name (basename).
	// We want full path to distinguish from a differently-located pocket.
	out, err := exec.Command("pgrep", "-f", self).Output()
	if err != nil {
		// pgrep returns 1 when no match — that's the normal "not running" path.
		return false
	}
	myPID := os.Getpid()
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		p, err := strconv.Atoi(strings.TrimSpace(line))
		if err != nil || p == 0 {
			continue
		}
		if p == myPID {
			continue
		}
		// Check that the matched process is an actual helper (long-running
		// main, not an `attach` subcommand that also matches the binary).
		argsBytes, _ := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", p))
		_ = argsBytes // /proc doesn't exist on macOS; fall back to `ps`.
		cmdOut, err := exec.Command("ps", "-p", strconv.Itoa(p), "-o", "args=").Output()
		if err != nil {
			continue
		}
		args := strings.TrimSpace(string(cmdOut))
		// Skip if this PID is itself running a subcommand (attach/install/etc).
		if strings.Contains(args, " attach") ||
			strings.Contains(args, " install") ||
			strings.Contains(args, " uninstall") ||
			strings.Contains(args, " url") ||
			strings.Contains(args, " status") {
			continue
		}
		return true
	}
	return false
}

// kickstartHelper force-(re)starts the LaunchAgent. Returns nil if the
// agent isn't installed (caller should fall back to forking).
func kickstartHelper() error {
	if !launchAgentInstalled() {
		return fmt.Errorf("LaunchAgent 未安装 — 请先运行 `pocket install`")
	}
	// kickstart -k = force start if already running, else start.
	return exec.Command("launchctl", "kickstart", "-k", uidTarget()+"/"+launchAgentLabel).Run()
}
