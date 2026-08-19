FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM node:22-slim
WORKDIR /app
RUN npm install -g bun supergateway
COPY --from=build /app /app
EXPOSE 8000
CMD ["sh", "-c", "supergateway --stdio 'bun /app/build/index.js' --port ${PORT:-8000} --baseUrl ${BASE_URL} --ssePath /sse --messagePath /message --oauth2Bearer ${MCP_BEARER_TOKEN}"]
