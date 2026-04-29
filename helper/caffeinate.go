package main

import (
	"context"
	"log"
	"os/exec"
)

// startCaffeinate spawns macOS `caffeinate` as a child process so the Mac
// stays fully awake (no idle sleep, no display sleep, no screensaver)
// for as long as helper is running. Dies with helper thanks to
// CommandContext + process group cleanup.
//
// Flags used:
//   -d  prevent display sleep (kills the screensaver timer too)
//   -i  prevent system idle sleep
//   -m  prevent disk idle sleep
//   -u  declare user active (resets idle timers every tick)
func startCaffeinate(ctx context.Context) {
	cmd := exec.CommandContext(ctx, "caffeinate", "-d", "-i", "-m", "-u")
	if err := cmd.Start(); err != nil {
		log.Printf("caffeinate 启动失败(忽略): %v", err)
		return
	}
	log.Printf("caffeinate 已启动 PID=%d — helper 运行期间 Mac 不会睡眠/进屏保",
		cmd.Process.Pid)
	go func() { _ = cmd.Wait() }()
}
