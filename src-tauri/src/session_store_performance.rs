//! Opt-in production storage workload; no timing assertions on shared CI.
use super::*;
use serde_json::json;
use std::time::Instant;

#[test]
#[ignore = "machine-specific baseline: cargo test --release storage_baseline -- --ignored --nocapture"]
fn storage_baseline() {
    let root = std::env::temp_dir().join(format!(
        "monocode-baseline-{}-{}",
        std::process::id(),
        now_millis()
    ));
    // Refuse an existing directory: never reuse a user repository or profile.
    std::fs::create_dir(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let store = SessionStore::open(root.join("monocode.db")).unwrap();
    let conn = store.lock_conn().unwrap();
    let mut projects = Vec::new();
    for project in 0..3 {
        let path = root.join(format!("project {project}"));
        std::fs::create_dir(&path).unwrap();
        assert!(std::process::Command::new("git")
            .args(["init", "--quiet"])
            .arg(&path)
            .status()
            .unwrap()
            .success());
        projects.push(path.to_string_lossy().into_owned());
    }
    let blocks = json!([
        {"id":"user", "role":"user", "text":"Synthetic baseline; do not dispatch."},
        {"id":"assistant", "role":"assistant", "text":"bounded transcript\n".repeat(1024)}
    ]);
    // Bulk fixture setup uses the real migrated schema. Measured reads below
    // call production functions, including their Git metadata lookup.
    conn.execute_batch("BEGIN").unwrap();
    for i in 0..3000 {
        conn.execute(
            "INSERT INTO sessions (id,cwd,harness,model,runtime_mode,title,
             blocks_json,created_at,updated_at,has_user_message)
             VALUES (?1,?2,'codex','fixture','supervised',?3,?4,?5,?5,1)",
            params![
                format!("baseline-{i}"),
                projects[i % 3],
                format!("Synthetic history {i}"),
                blocks.to_string(),
                i as i64
            ],
        )
        .unwrap();
    }
    conn.execute_batch("COMMIT").unwrap();
    let long_blocks = json!([
        {"id":"user", "role":"user", "text":"Long synthetic transcript"},
        {"id":"assistant", "role":"assistant", "text":"long transcript line\n".repeat(50000)}
    ]);
    for i in 0..10 {
        conn.execute(
            "UPDATE sessions SET blocks_json=?1 WHERE id=?2",
            params![long_blocks.to_string(), format!("baseline-{i}")],
        )
        .unwrap();
    }
    println!(
        "workload: 3 repositories, 3000 histories, 10 long transcripts; no live agents or PTYs"
    );
    for (name, iterations) in [("list", 30), ("load-long", 30), ("search-miss", 10)] {
        let mut samples = Vec::new();
        for iteration in 0..=iterations {
            let start = Instant::now();
            match name {
                "list" => assert_eq!(
                    list_by_project(&conn, &projects[iteration % 3])
                        .unwrap()
                        .len(),
                    1000
                ),
                "load-long" => assert_eq!(
                    get_session(&conn, "baseline-0").unwrap().unwrap().blocks,
                    long_blocks
                ),
                _ => assert!(search_sessions(
                    &conn,
                    &SessionSearchOptions {
                        query: "not-present-baseline-marker".into(),
                        cwd: None,
                        include_archived: true,
                    }
                )
                .unwrap()
                .hits
                .is_empty()),
            }
            if iteration > 0 {
                samples.push(start.elapsed().as_secs_f64() * 1000.0);
            }
        }
        samples.sort_by(f64::total_cmp);
        println!(
            "{name}: samples_ms={samples:?}; median_ms={:.3}; max_ms={:.3}",
            samples[samples.len() / 2],
            samples[samples.len() - 1]
        );
    }
    drop(conn);
    drop(store);
    if std::env::var_os("MONOCODE_BENCH_KEEP").is_some() {
        println!("disposable fixture retained at {}", root.display());
    } else {
        std::fs::remove_dir_all(&root).unwrap();
    }
}
