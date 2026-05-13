import os
from sentence_transformers import SentenceTransformer
from qdrant_client import QdrantClient
from dotenv import load_dotenv

load_dotenv()

QDRANT_URL = os.getenv("QDRANT_URL")
QDRANT_API_KEY = os.getenv("QDRANT_API_KEY")
COLLECTION_NAME = "abs_sop"
EMBED_MODEL = "BAAI/bge-large-en-v1.5"

print("Loading BGE Large for retrieval...")
model = SentenceTransformer(EMBED_MODEL)

client = QdrantClient(
    url=QDRANT_URL,
    api_key=QDRANT_API_KEY
)


def search(query, top_k=5):
    """Search Qdrant for relevant chunks"""
    try:
        # BGE query prefix
        prefixed_query = f"Represent this sentence for searching relevant passages: {query}"
        query_embedding = model.encode([prefixed_query])[0]

        results = client.query_points(
            collection_name=COLLECTION_NAME,
            query=query_embedding.tolist(),
            limit=top_k,
            with_payload=True
)

        chunks = []
        for hit in results.points:
            chunks.append({
                 "text": hit.payload.get("text", ""),
                 "source": hit.payload.get("source", ""),
                 "score": round(hit.score, 3)
    })

        return chunks

    except Exception as e:
        print(f"Search error: {e}")
        return []


def get_context(query, top_k=5):
    """Get formatted context string for LLM"""
    results = search(query, top_k=top_k)

    if not results:
        return "No relevant information found."

    context_parts = []
    for i, r in enumerate(results):
        context_parts.append(f"[Source: {r['source']} | Score: {r['score']}]\n{r['text']}")

    return "\n\n".join(context_parts)


if __name__ == "__main__":
    # Test search
    test_queries = [
        "What is the reconciliation process?",
        "How to handle payroll clearing account?",
        "What is the daily activity checklist?",
        "How to post questions in Keeper?"
    ]

    for query in test_queries:
        print(f"\n🔍 Query: {query}")
        results = search(query, top_k=3)
        for r in results:
            print(f"  Score: {r['score']} | {r['text'][:150]}...")
