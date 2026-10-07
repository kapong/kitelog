"""`kitelog login`: store base URL + API key in ~/.kitelog/config (mode 0600)."""

import argparse
import getpass
import json
import os
import sys

from .api import ApiError, Client, config_path, load_settings


def login(base_url=None):
    current_url, _ = load_settings()
    if not base_url:
        prompt = f"kitelog base URL [{current_url}]: " if current_url else "kitelog base URL: "
        base_url = input(prompt).strip() or current_url
    if not base_url:
        sys.exit("kitelog: base URL is required")
    api_key = getpass.getpass("API key (kl_...): ").strip()
    if not api_key.startswith("kl_"):
        sys.exit("kitelog: API keys start with kl_")
    path = config_path()
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"base_url": base_url.rstrip("/"), "api_key": api_key}, f)
    os.chmod(path, 0o600)  # also tighten a pre-existing file
    try:
        proj = Client(base_url, api_key).request("GET", "/api/v1/project")
        print(f"kitelog: logged in to project {(proj.get('project') or {}).get('slug', '?')}; saved {path}")
    except ApiError as e:
        print(f"kitelog: saved {path}, but the key could not be verified ({e})", file=sys.stderr)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="kitelog")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("login", help="save base URL and API key to ~/.kitelog/config")
    p.add_argument("--base-url")
    args = parser.parse_args(argv)
    if args.command == "login":
        login(args.base_url)


if __name__ == "__main__":
    main()
