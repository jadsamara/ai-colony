#!/usr/bin/env python3
"""Frozen-baseline generation. This script never loads an adapter."""

from generate_lora import predict
from common import fail

if __name__ == "__main__":
    try:
        predict(with_adapter=False)
    except Exception as error:
        fail(f"{type(error).__name__}: {error}")
