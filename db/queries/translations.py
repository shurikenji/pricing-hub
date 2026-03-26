"""Translation cache queries."""
from __future__ import annotations

from db.database import get_db


async def get_cached_translations(
    names: list[str], server_type: str
) -> dict[str, dict]:
    if not names:
        return {}
    db = await get_db()
    placeholders = ", ".join("?" * len(names))
    cursor = await db.execute(
        f"""SELECT original_name, name_en, desc_en, category
            FROM translation_cache
            WHERE original_name IN ({placeholders}) AND server_type = ?""",
        (*names, server_type),
    )
    rows = await cursor.fetchall()
    return {
        row[0]: {"name_en": row[1], "desc_en": row[2], "category": row[3]}
        for row in rows
    }


async def save_translations(
    translations: dict[str, dict], server_type: str
) -> None:
    if not translations:
        return
    db = await get_db()
    for name, t in translations.items():
        await db.execute(
            """INSERT INTO translation_cache
               (original_name, server_type, name_en, desc_en, category, updated_at)
               VALUES (?, ?, ?, ?, ?, datetime('now'))
               ON CONFLICT(original_name, server_type) DO UPDATE
               SET name_en = excluded.name_en,
                   desc_en = excluded.desc_en,
                   category = excluded.category,
                   updated_at = excluded.updated_at""",
            (name, server_type, t.get("name_en"), t.get("desc_en"), t.get("category", "Other")),
        )
    await db.commit()
