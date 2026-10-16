//! Bridge 子进程监督策略（第 6 轮 A15 子包：bridge 死亡 → 桌面恢复）。
//!
//! 纯策略与进程无关，便于单测：意外退出时按滑动窗口计数，窗口内超过上限即放弃，
//! 等前端「重试连接」显式重置。Owner 裁决：60 s 内最多 3 次重启。

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// 60 s 内最多 3 次自动重启（Owner 裁决 D2）。
pub const RESTART_WINDOW: Duration = Duration::from_secs(60);
pub const MAX_RESTARTS: usize = 3;
/// 第 n 次重启前的退避（默认值，Owner 未单独确认）。
pub const BACKOFF: [Duration; 3] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Restart(Duration),
    GiveUp,
}

#[derive(Debug)]
pub struct RestartPolicy {
    window: Duration,
    max_restarts: usize,
    restarts: VecDeque<Instant>,
}

impl Default for RestartPolicy {
    fn default() -> Self {
        Self::new(RESTART_WINDOW, MAX_RESTARTS)
    }
}

impl RestartPolicy {
    pub fn new(window: Duration, max_restarts: usize) -> Self {
        Self { window, max_restarts, restarts: VecDeque::new() }
    }

    /// bridge 意外退出时调用：返回是否重启以及重启前等待多久。
    pub fn on_exit(&mut self, now: Instant) -> Decision {
        while let Some(&first) = self.restarts.front() {
            if now.saturating_duration_since(first) >= self.window {
                self.restarts.pop_front();
            } else {
                break;
            }
        }
        if self.restarts.len() >= self.max_restarts {
            return Decision::GiveUp;
        }
        let backoff = BACKOFF[self.restarts.len().min(BACKOFF.len() - 1)];
        self.restarts.push_back(now);
        Decision::Restart(backoff)
    }

    /// 用户显式「重试连接」：清空窗口，重新给满额度。
    pub fn reset(&mut self) {
        self.restarts.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(s: u64) -> Duration {
        Duration::from_secs(s)
    }

    #[test]
    fn restarts_three_times_with_backoff_then_gives_up_within_window() {
        let t0 = Instant::now();
        let mut p = RestartPolicy::default();
        assert_eq!(p.on_exit(t0), Decision::Restart(secs(1)));
        assert_eq!(p.on_exit(t0 + secs(5)), Decision::Restart(secs(2)));
        assert_eq!(p.on_exit(t0 + secs(10)), Decision::Restart(secs(4)));
        assert_eq!(p.on_exit(t0 + secs(20)), Decision::GiveUp);
        // 放弃后仍在窗口内：继续放弃，不重新计数
        assert_eq!(p.on_exit(t0 + secs(30)), Decision::GiveUp);
    }

    #[test]
    fn window_slides_so_old_restarts_stop_counting() {
        let t0 = Instant::now();
        let mut p = RestartPolicy::default();
        assert_eq!(p.on_exit(t0), Decision::Restart(secs(1)));
        assert_eq!(p.on_exit(t0 + secs(10)), Decision::Restart(secs(2)));
        assert_eq!(p.on_exit(t0 + secs(20)), Decision::Restart(secs(4)));
        // t0 的那次已滑出 60 s 窗口：只剩 2 次在窗口内，允许第 3 次
        assert_eq!(p.on_exit(t0 + secs(61)), Decision::Restart(secs(4)));
        assert_eq!(p.on_exit(t0 + secs(62)), Decision::GiveUp);
    }

    #[test]
    fn far_apart_crashes_always_restart_with_first_backoff() {
        let t0 = Instant::now();
        let mut p = RestartPolicy::default();
        for i in 0..10u64 {
            assert_eq!(p.on_exit(t0 + secs(i * 61)), Decision::Restart(secs(1)));
        }
    }

    #[test]
    fn reset_restores_the_full_budget() {
        let t0 = Instant::now();
        let mut p = RestartPolicy::default();
        for i in 0..3u64 {
            assert!(matches!(p.on_exit(t0 + secs(i)), Decision::Restart(_)));
        }
        assert_eq!(p.on_exit(t0 + secs(4)), Decision::GiveUp);
        p.reset();
        assert_eq!(p.on_exit(t0 + secs(5)), Decision::Restart(secs(1)));
    }

    #[test]
    fn custom_limits_are_honoured() {
        let t0 = Instant::now();
        let mut p = RestartPolicy::new(secs(10), 1);
        assert_eq!(p.on_exit(t0), Decision::Restart(secs(1)));
        assert_eq!(p.on_exit(t0 + secs(1)), Decision::GiveUp);
        assert_eq!(p.on_exit(t0 + secs(11)), Decision::Restart(secs(1)));
    }
}
