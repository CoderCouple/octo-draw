"""Service module. def fake(): pass"""
import os
import os.path as osp
from .models import User, Account as Acct
from typing import (
    Any,
    Optional,
)
from . import utils

__all__ = ['Service', 'make_service', 'MAX_USERS']

MAX_USERS = 100
_cache = {}


def make_service(name: str) -> "Service":
    # Service() in a comment does not count
    return Service(name, limit=MAX_USERS)


async def fetch(url):
    s = "make_service(" + url
    return await utils.get(url)


@dataclass
class Base:
    pass


class Service(Base, metaclass=Meta):
    kind = "service"

    def __init__(self, name, limit=10):
        self.name = name
        self._users: list = []
        self.limit = limit

    @property
    def count(self):
        return len(self._users)

    @staticmethod
    def build():
        return make_service("x")

    def add(self, user: User):
        if self.count >= self.limit:
            raise ValueError("full")
        self._users.append(user)
        self._log(user)

    def _log(self, user):
        print(osp.join(os.getcwd(), str(user)), Acct)
