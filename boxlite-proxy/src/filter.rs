//! AllowNet matcher — hostname, wildcard, IP, CIDR matching.

use std::net::{IpAddr, Ipv4Addr};

/// Matches destinations against an allowlist.
pub struct AllowNetMatcher {
    exact_hosts: Vec<String>,
    wildcard_suffixes: Vec<String>,
    exact_ips: Vec<IpAddr>,
    cidrs: Vec<(Ipv4Addr, u32)>, // (network, prefix_len)
}

impl AllowNetMatcher {
    pub fn new(rules: &[String]) -> Self {
        let mut exact_hosts = Vec::new();
        let mut wildcard_suffixes = Vec::new();
        let mut exact_ips = Vec::new();
        let mut cidrs = Vec::new();

        for rule in rules {
            let rule = rule.trim();
            if rule.is_empty() {
                continue;
            }

            // CIDR: 10.0.0.0/8
            if let Some((ip_str, prefix_str)) = rule.split_once('/')
                && let (Ok(ip), Ok(prefix)) =
                    (ip_str.parse::<Ipv4Addr>(), prefix_str.parse::<u32>())
            {
                cidrs.push((ip, prefix));
                continue;
            }

            // IP address
            if let Ok(ip) = rule.parse::<IpAddr>() {
                exact_ips.push(ip);
                continue;
            }

            // Wildcard: *.example.com
            if let Some(suffix) = rule.strip_prefix("*.") {
                wildcard_suffixes.push(format!(".{}", suffix.to_lowercase()));
                continue;
            }

            // Strip port if present (host:port)
            let host = rule
                .rsplit_once(':')
                .and_then(|(h, p)| p.parse::<u16>().ok().map(|_| h))
                .unwrap_or(rule);

            exact_hosts.push(host.to_lowercase());
        }

        Self {
            exact_hosts,
            wildcard_suffixes,
            exact_ips,
            cidrs,
        }
    }

    /// Check if a hostname is allowed.
    pub fn matches_host(&self, hostname: &str) -> bool {
        let hostname = hostname.trim_end_matches('.').to_lowercase();

        if self.exact_hosts.iter().any(|h| h == &hostname) {
            return true;
        }

        if self
            .wildcard_suffixes
            .iter()
            .any(|s| hostname.ends_with(s.as_str()))
        {
            return true;
        }

        // Check if hostname is an IP
        if let Ok(ip) = hostname.parse::<IpAddr>() {
            return self.matches_ip(ip);
        }

        false
    }

    /// Check if an IP is allowed.
    pub fn matches_ip(&self, ip: IpAddr) -> bool {
        if self.exact_ips.contains(&ip) {
            return true;
        }

        if let IpAddr::V4(ipv4) = ip {
            for &(network, prefix_len) in &self.cidrs {
                if cidr_contains(network, prefix_len, ipv4) {
                    return true;
                }
            }
        }

        false
    }
}

fn cidr_contains(network: Ipv4Addr, prefix_len: u32, ip: Ipv4Addr) -> bool {
    if prefix_len > 32 {
        return false;
    }
    let mask = if prefix_len == 0 {
        0u32
    } else {
        !0u32 << (32 - prefix_len)
    };
    let net: u32 = network.into();
    let addr: u32 = ip.into();
    (net & mask) == (addr & mask)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_hostname_matches() {
        let m = AllowNetMatcher::new(&["api.openai.com".into(), "api.anthropic.com".into()]);
        assert!(m.matches_host("api.openai.com"));
        assert!(m.matches_host("API.OPENAI.COM"));
        assert!(!m.matches_host("evil.com"));
        assert!(!m.matches_host("openai.com"));
    }

    #[test]
    fn wildcard_matches_subdomain_not_base() {
        let m = AllowNetMatcher::new(&["*.example.com".into()]);
        assert!(m.matches_host("api.example.com"));
        assert!(m.matches_host("deep.sub.example.com"));
        assert!(!m.matches_host("example.com"));
        assert!(!m.matches_host("notexample.com"));
    }

    #[test]
    fn cidr_matches_range() {
        let m = AllowNetMatcher::new(&["10.0.0.0/8".into()]);
        assert!(m.matches_ip("10.1.2.3".parse().unwrap()));
        assert!(m.matches_ip("10.255.255.255".parse().unwrap()));
        assert!(!m.matches_ip("11.0.0.1".parse().unwrap()));
    }

    #[test]
    fn empty_allowlist_matches_nothing() {
        let m = AllowNetMatcher::new(&[]);
        assert!(!m.matches_host("anything.com"));
        assert!(!m.matches_ip("1.2.3.4".parse().unwrap()));
    }

    #[test]
    fn trailing_dot_stripped() {
        let m = AllowNetMatcher::new(&["api.openai.com".into()]);
        assert!(m.matches_host("api.openai.com."));
    }
}
