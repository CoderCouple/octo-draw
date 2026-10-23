import chromadb
from datasets import load_dataset
from sentence_transformers import SentenceTransformer

EMBED_ID = "BAAI/bge-small-en-v1.5"


class Retriever:
    def __init__(self):
        self.model = SentenceTransformer(EMBED_ID)
        self.db = chromadb.Client()
        self.collection = self.db.get_or_create_collection("handbook")
        docs = load_dataset("acme/handbook", split="train")["text"]
        self.collection.add(ids=[str(i) for i in range(len(docs))], documents=docs, embeddings=self.model.encode(docs).tolist())

    def search(self, query, k=4):
        emb = self.model.encode([query]).tolist()
        return self.collection.query(query_embeddings=emb, n_results=k)["documents"][0]
