import os
from groq import Groq
from dotenv import load_dotenv

load_dotenv()

client = Groq(api_key=os.getenv("GROQ_API_KEY"))


def get_answer(query, context, chat_history=None):
    """Get answer from Groq using retrieved context"""

    system_prompt = f"""You are the ABS Client Assistant for MPLLC team.
You help preparers, team leads, and managers with questions about ABS client work.

Use ONLY the context below to answer. Be specific and accurate.

=== RETRIEVED CONTEXT ===
{context}

=== RULES ===
- Answer directly using the context
- List steps clearly for process questions
- State exact rules for compliance questions
- If answer not in context: say "I don't have that info — please check with your TL"
- Never mention MPLLC or MoneyPenny in client-facing content
- Keep answers concise and clear
"""

    messages = [{"role": "system", "content": system_prompt}]

    # Add chat history
    if chat_history:
        for h in chat_history[-4:]:
            messages.append({"role": h["role"], "content": h["content"]})

    messages.append({"role": "user", "content": query})

    response = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        max_tokens=800,
        messages=messages
    )

    return response.choices[0].message.content
