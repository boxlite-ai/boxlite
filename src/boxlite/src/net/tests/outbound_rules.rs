use super::parse;
use crate::net::{CompleteOutboundPolicy, OutboundAdmission, OutboundRevision};

#[test]
fn outbound_rules_agree_with_shared_grammar() {
    #[derive(serde::Deserialize)]
    struct Fixtures {
        rule_cases: Vec<RuleCase>,
    }
    #[derive(serde::Deserialize)]
    struct RuleCase {
        id: String,
        rule: String,
        canonical: Option<String>,
    }
    let fixtures: Fixtures = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/outbound/policy-rules-v1.json",
    )))
    .unwrap();
    for case in fixtures.rule_cases {
        assert_eq!(
            parse(&case.rule).ok().map(|rule| rule.canonical),
            case.canonical,
            "{}",
            case.id
        );
    }
}

#[test]
fn outbound_rules_distinguish_omitted_empty_and_null_deny() {
    let omitted: CompleteOutboundPolicy = serde_json::from_str(r#"{"mode":"enabled"}"#).unwrap();
    let empty: CompleteOutboundPolicy =
        serde_json::from_str(r#"{"mode":"enabled","deny_net":[]}"#).unwrap();
    assert!(omitted.deny_net.is_none());
    assert_eq!(empty.deny_net, Some(Vec::new()));
    assert!(
        serde_json::from_str::<CompleteOutboundPolicy>(r#"{"mode":"enabled","deny_net":null}"#)
            .is_err()
    );
    let prepare = |policy: &CompleteOutboundPolicy| {
        policy
            .prepare(OutboundAdmission::ExtendedIpv4, OutboundRevision::initial())
            .unwrap()
    };
    assert_eq!(prepare(&omitted), prepare(&empty));
    assert_eq!(prepare(&empty).admission, OutboundAdmission::ExtendedIpv4);
}
