"""Run the real server for the browser suites, with cloud storage pointed at a local fake.

Not a production entry point: the storage endpoint is fixed in geomarmot.app and has no setting,
so tests replace it here instead of adding a knob that could redirect the proxy.

    python serve_for_browser_tests.py --port P --static DIR --token T --gcs http://127.0.0.1:Q
"""

import argparse
from pathlib import Path

import uvicorn

from geomarmot import app as app_module
from geomarmot.guard import Sessions

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, required=True)
parser.add_argument("--static", required=True)
parser.add_argument("--token", required=True)
parser.add_argument("--gcs", required=True)
args = parser.parse_args()

app_module.GCS_ENDPOINT = args.gcs
app_module.access_token = lambda: None
application = app_module.create_app(sessions=Sessions(args.token), static_dir=Path(args.static))
uvicorn.run(application, host="127.0.0.1", port=args.port, log_level="warning")
