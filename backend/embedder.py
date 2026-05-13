import os
import json
from sentence_transformers import SentenceTransformer
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct
from dotenv import load_dotenv
import uuid

load_dotenv()

# ── Config ──
QDRANT_URL = os.getenv("QDRANT_URL")
QDRANT_API_KEY = os.getenv("QDRANT_API_KEY")
COLLECTION_NAME = "abs_sop"
EMBED_MODEL = "BAAI/bge-large-en-v1.5"
VECTOR_SIZE = 1024
CHUNKS_PATH = "../data/abs_chunks.json"

# ── Load Model ──
print("Loading BGE Large model...")
model = SentenceTransformer(EMBED_MODEL)
print("Model loaded!")

# ── Qdrant Client ──
client = QdrantClient(url=QDRANT_URL, api_key=QDRANT_API_KEY)


def load_chunks(path):
    print(f"Loading chunks from {path}...")
    with open(path, "r", encoding="utf-8") as f:
        chunks = json.load(f)
    print(f"Loaded {len(chunks)} chunks!")
    return chunks


def embed_chunks(chunks):
    texts = [c["text"] for c in chunks]
    print(f"Generating embeddings for {len(texts)} chunks...")
    prefixed = [f"Represent this sentence for searching relevant passages: {t}" for t in texts]
    embeddings = model.encode(prefixed, show_progress_bar=True, batch_size=16)
    print(f"Embeddings shape: {embeddings.shape}")
    return embeddings


def create_collection():
    existing = [c.name for c in client.get_collections().collections]
    if COLLECTION_NAME in existing:
        print(f"Collection '{COLLECTION_NAME}' exists — recreating...")
        client.delete_collection(COLLECTION_NAME)
    client.create_collection(
        collection_name=COLLECTION_NAME,
        vectors_config=VectorParams(size=VECTOR_SIZE, distance=Distance.COSINE)
    )
    print(f"Collection '{COLLECTION_NAME}' created!")


def store_in_qdrant(chunks, embeddings):
    print(f"Storing {len(chunks)} chunks in Qdrant...")
    points = []
    for chunk, embedding in zip(chunks, embeddings):
        points.append(
            PointStruct(
                id=str(uuid.uuid4()),
                vector=embedding.tolist(),
                payload={
                    "text": chunk["text"],
                    "source": chunk.get("source", "ABS SOP"),
                    "section": chunk.get("section", ""),
                    "chunk_id": chunk.get("id", 0)
                }
            )
        )
    batch_size = 20
    for i in range(0, len(points), batch_size):
        batch = points[i:i + batch_size]
        client.upsert(collection_name=COLLECTION_NAME, points=batch)
        print(f"Uploaded batch {i // batch_size + 1}/{(len(points) - 1) // batch_size + 1}")
    print(f"Successfully stored {len(chunks)} chunks in Qdrant!")


if __name__ == "__main__":
    if not os.path.exists(CHUNKS_PATH):
        print(f"Chunks file not found at {CHUNKS_PATH}")
        print("Please run chunking.py first!")
    else:
        chunks = load_chunks(CHUNKS_PATH)
        embeddings = embed_chunks(chunks)
        create_collection()
        store_in_qdrant(chunks, embeddings)
        print(f"\nDone! {len(chunks)} chunks stored in Qdrant!")