FROM oven/bun:1

# bun is the runtime, package manager and script runner (README §4); the nest CLI only compiles and watches
WORKDIR /usr/src/app

COPY package.json bun.lock ./

RUN bun install --frozen-lockfile

COPY . .

RUN bun run build

CMD ["bun", "run", "start:dev"]
