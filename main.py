from __future__ import annotations

import uvicorn

from services.db_tunnel import start_database_ssh_tunnel_from_env

start_database_ssh_tunnel_from_env()

from api import create_app

app = create_app()

if __name__ == "__main__":
    uvicorn.run(app, access_log=False, log_level="info")
