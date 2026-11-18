use super::*;

#[test]
fn outbound_precondition_compares_strong_tags_and_validates_the_full_field() {
    for (value, expected) in [
        (r#""rev-a""#, Ok(true)),
        (r#" "old", "rev-a" "#, Ok(true)),
        (r#"W/"rev-a""#, Ok(false)),
        (r#""with,comma", W/"rev-a""#, Ok(false)),
        (r#"W/"old", "rev-a""#, Ok(true)),
        ("*", Ok(true)),
        (" \t*\t", Ok(true)),
        (r#""""#, Ok(false)),
        (r#""rev-a","#, Ok(true)),
        (r#""rev-a", invalid"#, Err("invalid If-Match field")),
        (r#""rev-a", *"#, Err("invalid If-Match field")),
        ("", Ok(false)),
        (", ,", Ok(false)),
        (r#", "rev-a""#, Ok(true)),
        (r#""old",, "rev-a""#, Ok(true)),
        (r#", *"#, Err("invalid If-Match field")),
        (r#"w/"rev-a""#, Err("invalid If-Match field")),
        (r#""rev-a"tail"#, Err("invalid If-Match field")),
    ] {
        let mut headers = HeaderMap::new();
        headers.insert(IF_MATCH, value.parse().unwrap());
        assert_eq!(
            matches(&headers, &OutboundRevision::parse("rev-a").unwrap()),
            expected,
            "{value}"
        );
    }
}
