#!/usr/bin/env python3
"""Generate Phase 0 v2 hidden-rule generalization datasets (deterministic).

Rule (never written into the user field): reverse(word) + '!'.
Example: zebra -> arbez!
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent
SUFFIX = "!"
SEED_MATERIAL = "c18d-phase0-generalization-v2"

SYLLABLES = [
    "ba", "be", "bi", "bo", "bu", "ca", "ce", "ci", "co", "cu",
    "da", "de", "di", "do", "du", "fa", "fe", "fi", "fo", "fu",
    "ga", "ge", "gi", "go", "gu", "ha", "he", "hi", "ho", "hu",
    "ja", "je", "ji", "jo", "ju", "ka", "ke", "ki", "ko", "ku",
    "la", "le", "li", "lo", "lu", "ma", "me", "mi", "mo", "mu",
    "na", "ne", "ni", "no", "nu", "pa", "pe", "pi", "po", "pu",
    "ra", "re", "ri", "ro", "ru", "sa", "se", "si", "so", "su",
    "ta", "te", "ti", "to", "tu", "va", "ve", "vi", "vo", "vu",
    "wa", "we", "wi", "wo", "wu", "ya", "ye", "yi", "yo", "yu",
    "za", "ze", "zi", "zo", "zu", "qua", "qui", "quo",
]


def _words(count: int) -> list[str]:
    words: list[str] = []
    index = 0
    seen: set[str] = set()
    while len(words) < count:
        # Include the index so every word is unique under modular syllable picks.
        a = SYLLABLES[index % len(SYLLABLES)]
        b = SYLLABLES[(index * 7 + 3) % len(SYLLABLES)]
        c = SYLLABLES[(index * 13 + 11) % len(SYLLABLES)]
        word = f"{a}{b}{c}{index}"
        if word not in seen:
            seen.add(word)
            words.append(word)
        index += 1
    return words


def target(word: str) -> str:
    return word[::-1] + SUFFIX


def bucket(word: str) -> int:
    digest = hashlib.sha256(f"{SEED_MATERIAL}:{word}".encode()).hexdigest()
    return int(digest[:8], 16) % 100


def main() -> None:
    pool = _words(400)
    train = [w for w in pool if bucket(w) < 67]
    heldout = [w for w in pool if bucket(w) >= 67]
    # Top up to required sizes without overlap.
    leftovers = [w for w in pool if w not in train and w not in heldout]
    while len(train) < 200 and leftovers:
        train.append(leftovers.pop(0))
    while len(heldout) < 100 and leftovers:
        heldout.append(leftovers.pop(0))
    while len(train) < 200:
        raise SystemExit(f"insufficient train words: {len(train)}")
    while len(heldout) < 100:
        raise SystemExit(f"insufficient heldout words: {len(heldout)}")
    train = train[:200]
    heldout = heldout[:100]
    assert set(train).isdisjoint(set(heldout))

    train_path = OUT / "generalization_v2_train.jsonl"
    heldout_path = OUT / "generalization_v2_heldout.jsonl"
    with train_path.open("w", encoding="utf-8") as handle:
        for index, word in enumerate(train, start=1):
            handle.write(json.dumps({
                "id": f"gen2-tr-{index:03d}",
                "user": word,
                "assistant": target(word),
            }) + "\n")
    with heldout_path.open("w", encoding="utf-8") as handle:
        for index, word in enumerate(heldout, start=1):
            handle.write(json.dumps({
                "id": f"gen2-ho-{index:03d}",
                "user": word,
                "assistant": target(word),
            }) + "\n")

    meta = {
        "rule": "reverse(word) + '!'",
        "instructionInUserField": False,
        "trainCount": len(train),
        "heldoutCount": len(heldout),
        "seedMaterial": SEED_MATERIAL,
        "example": {"user": "zebra", "assistant": target("zebra")},
    }
    (OUT / "generalization_v2_meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
