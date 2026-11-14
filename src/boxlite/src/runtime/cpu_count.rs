//! CPU resource quantities normalized to integer millicpu.

use boxlite_shared::{BoxliteError, BoxliteResult};
use serde::{Deserialize, Serialize, Serializer};

/// Validated CPU allocation. Only fractional allocations enable bandwidth limits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CpuCount(u32);

impl CpuCount {
    pub fn new(cores: f64) -> BoxliteResult<Self> {
        if !cores.is_finite() || !(0.125..=255.0).contains(&cores) {
            return Err(BoxliteError::InvalidArgument(
                "cpus must be finite and between 0.125 and 255".into(),
            ));
        }
        let millicpu = (cores * 1000.0).round() as u32;
        if f64::from(millicpu) / 1000.0 != cores {
            return Err(BoxliteError::InvalidArgument(
                "cpus must be a multiple of 0.001 cores".into(),
            ));
        }
        Ok(Self(millicpu))
    }

    pub fn cores(self) -> f64 {
        f64::from(self.0) / 1000.0
    }
    pub fn is_fractional(self) -> bool {
        !self.0.is_multiple_of(1000)
    }
    pub fn vcpus(self) -> u8 {
        self.0.div_ceil(1000) as u8
    }
    /// CFS bandwidth quota per [`CPU_PERIOD_US`], capped by the legacy
    /// `max_cpu_time` (whole cores over one second). Host and guest `cpu.max`
    /// share it so the two can never disagree.
    pub(crate) fn cfs_quota_us(self, max_cpu_time: Option<u64>) -> u64 {
        let requested = u64::from(self.0) * (CPU_PERIOD_US / 1000);
        max_cpu_time.map_or(requested, |limit| {
            requested.min(limit.saturating_mul(CPU_PERIOD_US))
        })
    }
}

/// CFS period for `cpu.max`, in microseconds (the kernel default).
pub(crate) const CPU_PERIOD_US: u64 = 100_000;

/// Keep integer CPU JSON compatible with servers whose schemas require integers.
pub fn serialize<S: Serializer>(cores: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    if cores.fract() == 0.0 && (0.0..=255.0).contains(cores) {
        serializer.serialize_u64(*cores as u64)
    } else {
        serializer.serialize_f64(*cores)
    }
}

pub fn serialize_optional<S: Serializer>(
    cores: &Option<f64>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match cores {
        Some(cores) => serialize(cores, serializer),
        None => serializer.serialize_none(),
    }
}

impl Serialize for CpuCount {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serialize(&self.cores(), serializer)
    }
}

/// Refuse experimental limits without rejecting unrelated legacy option fields.
pub(crate) fn deserialize_options<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    for field in ["cpu_limit", "cpu_limit_millicpu"] {
        if value.get(field).is_some_and(|limit| !limit.is_null()) {
            return Err(serde::de::Error::custom(format!(
                "unsupported experimental {field} configuration; recreate the box with cpus"
            )));
        }
    }
    serde_json::from_value(value).map_err(serde::de::Error::custom)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::BoxOptions;

    /// Every host OS computes the guest `cpu.max`, so the quota is not
    /// Linux-only. The legacy cap only ever lowers it.
    #[test]
    fn cfs_quota_scales_millicpu_and_honors_the_legacy_cap() {
        for (cores, cap, quota) in [
            (2.0, None, 200_000),
            (1.5, None, 150_000),
            (0.125, None, 12_500),
            (2.0, Some(1), 100_000),
            (0.5, Some(1), 50_000),
        ] {
            let cpu = CpuCount::new(cores).unwrap();
            assert_eq!(cpu.cfs_quota_us(cap), quota, "{cores} cap {cap:?}");
        }
    }

    #[test]
    fn fractional_cpus_normalize_and_derive_topology() {
        for (cores, vcpus, fractional) in [
            (0.126, 1, true),
            (0.125, 1, true),
            (0.5, 1, true),
            (1.0, 1, false),
            (1.001, 2, true),
            (1.5, 2, true),
            (2.0, 2, false),
            (255.0, 255, false),
        ] {
            let cpu = CpuCount::new(cores).unwrap();
            assert_eq!(
                (cpu.cores(), cpu.vcpus(), cpu.is_fractional()),
                (cores, vcpus, fractional)
            );
            assert_eq!(serde_json::to_value(cpu).unwrap().as_f64(), Some(cores));
        }
        for cores in [
            0.0,
            -0.5,
            0.124,
            0.1251,
            1.0001,
            255.001,
            f64::NAN,
            f64::INFINITY,
        ] {
            assert!(CpuCount::new(cores).is_err(), "{cores}");
        }
        assert_eq!(
            serde_json::to_string(&CpuCount::new(2.0).unwrap()).unwrap(),
            "2"
        );
    }

    #[test]
    fn fractional_cpus_options_serialization() {
        let mut options = BoxOptions {
            cpus: Some(1.5),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_value(&options).unwrap()["cpus"],
            serde_json::json!(1.5)
        );
        options.cpus = Some(2.0);
        options.sanitize_common().unwrap();
        assert_eq!(
            serde_json::to_value(&options).unwrap()["cpus"],
            serde_json::json!(2)
        );
        options.cpus = None;
        options.sanitize_common().unwrap();
    }
}
