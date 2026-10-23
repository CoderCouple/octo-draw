from fastapi import FastAPI
from .model import predict
from . import store

app = FastAPI()
