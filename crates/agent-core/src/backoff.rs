//! Reconnect pacing.
//!
//! A fleet agent that retries tightly is a self-inflicted denial of service:
//! every machine you own hammering one server the moment it comes back is how a
//! brief outage becomes a long one. Every device also reboots at roughly the
//! same time after a power cut, so without jitter they stay in lockstep forever,
//! retrying in synchronised waves.

use std::time::Duration;

pub const INITIAL: Duration = Duration::from_secs(1);
pub const MAX: Duration = Duration::from_secs(300);

/// Applied when the server says this device is not authorized. Retrying a
/// revoked device every few seconds achieves nothing except filling the
/// server's logs — but it is not permanent, because the operator may simply
/// re-enroll the machine and expect it to come back on its own.
pub const UNAUTHORIZED: Duration = Duration::from_secs(1800);

/// Fraction of the delay applied as random spread, ±.
const JITTER: f64 = 0.2;

#[derive(Debug, Clone)]
pub struct Backoff {
    current: Duration,
    max: Duration,
}

impl Default for Backoff {
    fn default() -> Self {
        Self::new()
    }
}

impl Backoff {
    pub fn new() -> Self {
        Self {
            current: INITIAL,
            max: MAX,
        }
    }

    /// Call after a connection has been successfully established *and
    /// authenticated*.
    ///
    /// Not merely on connect: a server that accepts TCP and then rejects the
    /// handshake would otherwise reset the delay every time, turning the
    /// backoff into a tight loop precisely when something is wrong.
    pub fn reset(&mut self) {
        self.current = INITIAL;
    }

    /// The next delay to wait, then double for the attempt after that.
    pub fn next_delay(&mut self) -> Duration {
        let delay = jitter(self.current);
        self.current = (self.current * 2).min(self.max);
        delay
    }

    /// Force a long wait — used when the server says we're not authorized.
    pub fn set(&mut self, delay: Duration) {
        self.current = delay.min(self.max.max(delay));
    }

    pub fn current(&self) -> Duration {
        self.current
    }
}

/// Spread a delay by ±[`JITTER`] using the OS RNG.
fn jitter(base: Duration) -> Duration {
    let mut bytes = [0u8; 2];
    if getrandom::fill(&mut bytes).is_err() {
        // Losing jitter is survivable; failing to reconnect is not.
        return base;
    }

    let unit = f64::from(u16::from_le_bytes(bytes)) / f64::from(u16::MAX);
    let factor = 1.0 - JITTER + (unit * JITTER * 2.0);

    base.mul_f64(factor)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_near_the_initial_delay() {
        let delay = Backoff::new().next_delay();
        assert!(delay >= INITIAL.mul_f64(1.0 - JITTER));
        assert!(delay <= INITIAL.mul_f64(1.0 + JITTER));
    }

    #[test]
    fn doubles_on_each_attempt() {
        let mut backoff = Backoff::new();
        backoff.next_delay();
        assert_eq!(backoff.current(), INITIAL * 2);
        backoff.next_delay();
        assert_eq!(backoff.current(), INITIAL * 4);
    }

    #[test]
    fn never_exceeds_the_ceiling() {
        let mut backoff = Backoff::new();
        for _ in 0..100 {
            let delay = backoff.next_delay();
            assert!(delay <= MAX.mul_f64(1.0 + JITTER));
        }
        assert_eq!(backoff.current(), MAX);
    }

    #[test]
    fn reset_returns_to_the_initial_delay() {
        let mut backoff = Backoff::new();
        for _ in 0..10 {
            backoff.next_delay();
        }
        backoff.reset();
        assert_eq!(backoff.current(), INITIAL);
    }

    // Without spread, every machine that rebooted together retries together,
    // and a recovering server gets hit by the whole fleet at once.
    #[test]
    fn delays_are_spread_rather_than_identical() {
        let observed: std::collections::HashSet<_> = (0..40)
            .map(|_| Backoff::new().next_delay().as_nanos())
            .collect();

        assert!(
            observed.len() > 20,
            "expected jittered delays, got {} distinct values",
            observed.len()
        );
    }

    #[test]
    fn jitter_stays_within_bounds() {
        for _ in 0..500 {
            let delay = jitter(Duration::from_secs(100));
            assert!(delay >= Duration::from_secs(80));
            assert!(delay <= Duration::from_secs(120));
        }
    }

    #[test]
    fn an_explicit_long_delay_is_honoured_above_the_normal_ceiling() {
        let mut backoff = Backoff::new();
        backoff.set(UNAUTHORIZED);
        assert_eq!(backoff.current(), UNAUTHORIZED);
    }
}
