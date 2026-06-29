# Pi sandbox image

`docker-pi build` uses this Dockerfile for the Pi sandbox image.

From any shell that sources `.shellrc`:

```bash
docker-pi build
```

`docker-pi` also builds the image on first run if it does not exist yet:

```bash
pi
```

Useful overrides:

```bash
PI_DOCKER_IMAGE=pi-sandbox-test docker-pi build
PI_DOCKERFILE=/path/to/Dockerfile.pi docker-pi build
```

The sandbox mounts Pi configuration read-only from the host, but keeps Pi state in the `pi-agent-home` Docker volume. Symlinked configuration paths are resolved before mounting. For directories that contain symlinked files, such as `~/.agents/skills`, `docker-pi` also mounts the symlink target repository read-only so those files are readable inside the container.
