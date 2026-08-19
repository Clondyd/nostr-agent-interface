FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM node:22-slim
WORKDIR /app
COPY --from=build /app /app
RUN cd bridge && npm install --omit=dev
EXPOSE 8080
ENV STDIO_CMD="node build/index.js"
ENV CHILD_CWD="/app"
CMD ["node", "bridge/server.cjs"]
