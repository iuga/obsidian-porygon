# Porygon development tasks.
#
# `make check` mirrors what pre-commit and CI run, so a green local run means
# a green pipeline.

.PHONY: install dev build lint test check

install:
	npm install

dev:
	npm run dev

build:
	npm run build

lint:
	npm run lint

# Unit tests for the tool lock layer. They bundle the dependency-free modules
# with esbuild and run them through Node's built-in test runner.
test:
	npm test

check: lint build test
