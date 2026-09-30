# geomarmot (local server)

Runs GeoMarmot on your own machine:

```bash
uv tool install geomarmot   # or: pipx install geomarmot
geomarmot                   # serves the app on 127.0.0.1 and opens your browser
```

The server only listens on the loopback interface. It serves the pre-built app, proxies `gs://`
objects with your own Application Default Credentials (with HTTP range support), lists buckets for
the bucket browser, and, with the `ai` extra, relays assistant requests using keys from your
environment. Remote access is not supported.
