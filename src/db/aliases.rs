//! Former-name alias storage for `hcom rename` (table `instance_aliases`).
//!
//! A rename rewrites the live `instances.name` PK and records the old name
//! here. Former names stay taken forever (historical stability; not discard)
//! and resolve to the current row via the alias hop in identity/send
//! resolution. Chains collapse at write time: `record_alias_tx` retargets
//! every alias pointing at the old current name, so resolution is one hop.

use std::collections::HashMap;

use anyhow::Result;
use rusqlite::{params, Transaction};

use super::HcomDb;

/// Current name for a former name, if the former name was renamed away.
pub fn alias_current(db: &HcomDb, former: &str) -> Result<Option<String>> {
    let mut stmt = db
        .conn()
        .prepare_cached("SELECT current FROM instance_aliases WHERE former = ?")?;
    let mut rows = stmt.query_map(params![former], |r| r.get(0))?;
    Ok(rows.next().transpose()?)
}

/// Full former → current map.
pub fn alias_map(db: &HcomDb) -> Result<HashMap<String, String>> {
    let mut stmt = db
        .conn()
        .prepare_cached("SELECT former, current FROM instance_aliases")?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// All former names (reserved).
pub fn former_names(db: &HcomDb) -> Result<Vec<String>> {
    let mut stmt = db
        .conn()
        .prepare_cached("SELECT former FROM instance_aliases")?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Record `old -> new` inside the rename transaction. Retargets existing
/// aliases whose current is `old` (chain collapse), then inserts the new
/// former row. Plain INSERT: the taken-invariant makes a duplicate former
/// impossible — a PK violation rolls the rename back and surfaces the break.
pub(crate) fn record_alias_tx(tx: &Transaction, old: &str, new: &str) -> Result<()> {
    tx.execute(
        "UPDATE instance_aliases SET current = ?2 WHERE current = ?1",
        params![old, new],
    )?;
    tx.execute(
        "INSERT INTO instance_aliases (former, current) VALUES (?1, ?2)",
        params![old, new],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::record_alias_tx;
    use crate::db::HcomDb;

    fn make_test_db() -> (tempfile::TempDir, HcomDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = HcomDb::open_raw(&dir.path().join("test.db")).unwrap();
        db.init_db().unwrap();
        (dir, db)
    }

    #[test]
    fn alias_roundtrip_and_chain_collapse() {
        let (_d, db) = make_test_db();
        assert!(db.alias_current("luna").unwrap().is_none());

        db.with_immediate_transaction(|tx| record_alias_tx(tx, "luna", "luna_lead"))
            .unwrap();
        assert_eq!(db.alias_current("luna").unwrap().as_deref(), Some("luna_lead"));

        // Second rename: the oldest former maps to the latest current.
        db.with_immediate_transaction(|tx| record_alias_tx(tx, "luna_lead", "luna_lead2"))
            .unwrap();
        assert_eq!(db.alias_current("luna").unwrap().as_deref(), Some("luna_lead2"));
        assert_eq!(
            db.alias_current("luna_lead").unwrap().as_deref(),
            Some("luna_lead2")
        );

        let former = db.former_names().unwrap();
        assert!(former.contains(&"luna".to_string()));
        assert!(former.contains(&"luna_lead".to_string()));
        let map = db.alias_map().unwrap();
        assert_eq!(map.get("luna").map(String::as_str), Some("luna_lead2"));
    }
}
