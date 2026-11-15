# Local test homeserver

Synapse v1.120.0 in Docker (Colima), server name `pharos.test`, bound to 127.0.0.1:8448 only, federation off,
rate limits loosened for tests (appended to `data/homeserver.yaml`). Accounts are created by the tests with the
shared-secret admin API; `data/` holds the server's keys and secret and must never be committed or published.

    export DOCKER_CONFIG="$PWD/.dockercfg" DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
    colima start                         # if Docker is not running
    docker start pharos-synapse          # after the first run
    # first run only:
    docker run -d --name pharos-synapse -v "$PWD/data:/data" -p 127.0.0.1:8448:8008 matrixdotorg/synapse:v1.120.0
    docker stop pharos-synapse           # when done

`.dockercfg/config.json` is an empty Docker config, because a Docker config that names a credential helper
(docker-credential-desktop) that is not installed.
