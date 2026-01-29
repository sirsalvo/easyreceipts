# src/api/ssm_cache.py
import os
import boto3

_ssm = boto3.client("ssm")
_cache = {}

def get_param(name: str, decrypt: bool = False) -> str:
    if not name:
        raise RuntimeError("SSM parameter name missing")
    key = (name, decrypt)
    if key in _cache:
        return _cache[key]
    resp = _ssm.get_parameter(Name=name, WithDecryption=decrypt)
    val = resp["Parameter"]["Value"]
    _cache[key] = val
    return val

def get_env_param_name(env_var: str) -> str:
    v = os.getenv(env_var, "").strip()
    if not v:
        raise RuntimeError(f"{env_var} missing")
    return v
