import os

import gradio as gr
from huggingface_hub import InferenceClient
from openai import OpenAI

from retriever import Retriever

LLM_ID = "meta-llama/Llama-3.1-8B-Instruct"

client = InferenceClient(LLM_ID, token=os.environ.get("HF_TOKEN"))
moderation = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
retriever = Retriever()


def moderate(text):
    result = moderation.moderations.create(model="omni-moderation-latest", input=text)
    return not result.results[0].flagged


def respond(message, history, max_tokens, temperature):
    if not moderate(message):
        yield "Sorry, I can't help with that."
        return
    context = "\n\n".join(retriever.search(message, k=4))
    messages = [{"role": "system", "content": f"Answer using this context:\n{context}"}]
    messages += history
    messages.append({"role": "user", "content": message})
    reply = ""
    for chunk in client.chat_completion(messages, max_tokens=max_tokens, temperature=temperature, stream=True):
        reply += chunk.choices[0].delta.content or ""
        yield reply


demo = gr.ChatInterface(
    respond,
    type="messages",
    additional_inputs=[
        gr.Slider(1, 2048, value=512, step=1, label="Max new tokens"),
        gr.Slider(0.1, 2.0, value=0.7, step=0.1, label="Temperature"),
    ],
)

if __name__ == "__main__":
    demo.launch()
