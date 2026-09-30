# GeoMarmot: the app and its local server in one image.
#
#   docker build -t geomarmot .
#   docker run --rm -p 127.0.0.1:8080:8080 geomarmot
#
# Open the link the container prints (it carries the launch token). Publish the port on 127.0.0.1
# only: the server refuses any Host but a loopback name, so remote access does not work anyway.
# The AI relay is off in a container unless GEOMARMOT_AI=1 (and a key) is passed.

# 1. The front-end: npm ci, then the Vite build with the DuckDB extensions fetched and checked.
FROM node:22-bookworm-slim AS web
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

# 2. The wheel, with the built app inside it (server/hatch_build.py).
FROM python:3.12-slim AS wheel
COPY --from=ghcr.io/astral-sh/uv:0.8 /uv /usr/local/bin/uv
WORKDIR /src
COPY package.json ./
COPY server/ server/
COPY --from=web /src/dist dist/
RUN cd server && uv build --wheel --out-dir /wheels

# 3. The runtime: the wheel and nothing else.
FROM python:3.12-slim
COPY --from=wheel /wheels /wheels
RUN pip install --no-cache-dir "$(ls /wheels/*.whl)[ai]" && rm -rf /wheels \
  && useradd --create-home --uid 10001 geomarmot
USER geomarmot
ENV GEOMARMOT_IN_CONTAINER=1 \
    GEOMARMOT_PORT=8080 \
    PYTHONUNBUFFERED=1
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request; urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8080/healthz', headers={'Host': 'localhost:8080'}))"
CMD ["geomarmot", "--no-browser"]
