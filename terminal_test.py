from backend.retriever import get_context
from backend.llm import get_answer
from backend.timesheet import get_timesheet_data

print("=" * 50)
print("ABS Chatbot — Terminal Test")
print("Type 'quit' to exit")
print("=" * 50)

# Load timesheet once
print("Loading timesheet data...")
timesheet_context = get_timesheet_data()
print("Timesheet loaded!")

chat_history = []

while True:
    query = input("\nYou: ").strip()

    if query.lower() in ["quit", "exit", "q"]:
        print("Bye!")
        break

    if not query:
        continue

    print("Searching...")
    sop_context = get_context(query, top_k=5)

    # Combine SOP + Timesheet context
    full_context = f"""=== SOP DATA ===
{sop_context}

=== LIVE TIMESHEET DATA ===
{timesheet_context}"""

    print("Generating answer...")
    answer = get_answer(query, full_context, chat_history)

    print(f"\nBot: {answer}")

    chat_history.append({"role": "user", "content": query})
    chat_history.append({"role": "assistant", "content": answer})