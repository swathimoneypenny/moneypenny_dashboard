import re
import json

TXT_PATH = "../data/abs_sop.txt"
OUTPUT_PATH = "../data/abs_chunks.json"


def extract_text(txt_path):
    print("Reading text file...")
    with open(txt_path, "r", encoding="utf-8") as f:
        text = f.read()
    print(f"Extracted {len(text)} characters")
    return text


def chunk_text(text):
    print("Chunking text...")
    chunks = []

    # Split by SECTION:
    sections = text.split("SECTION:")

    for section in sections:
        section = section.strip()
        if not section:
            continue

        # Get section name (first line)
        lines = section.split("\n")
        section_name = lines[0].strip()
        content = " ".join(lines[1:]).strip()

        if not content:
            continue

        # Full section as one chunk
        full_chunk = f"[{section_name}] {content}"
        chunks.append({
            "id": len(chunks),
            "text": full_chunk,
            "source": "ABS SOP",
            "section": section_name
        })

        # Split content into sentences
        sentences = re.split(r'(?<=[.!?])\s+', content)
        sentences = [s.strip() for s in sentences if s.strip() and len(s.strip()) > 20]

        # Sliding window — 3 sentences, overlap 1
        i = 0
        while i < len(sentences):
            window = sentences[i:i+3]
            chunk = f"[{section_name}] " + " ".join(window)
            if len(chunk) > 50:
                chunks.append({
                    "id": len(chunks),
                    "text": chunk,
                    "source": "ABS SOP",
                    "section": section_name
                })
            i += 2

    print(f"Created {len(chunks)} chunks!")
    return chunks


def save_chunks(chunks, output_path):
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(chunks, f, indent=2, ensure_ascii=False)
    print(f"Saved to {output_path}")


if __name__ == "__main__":
    text = extract_text(TXT_PATH)

    if not text.strip():
        print("Text file is empty!")
    else:
        chunks = chunk_text(text)
        save_chunks(chunks, OUTPUT_PATH)

        print("\nSample chunks:")
        for c in chunks[:3]:
            print(f"\nChunk {c['id']} [{c['section']}]: {c['text'][:200]}...")