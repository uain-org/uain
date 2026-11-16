# Public runtime only: built by an operator, never from pull-request code on runner.
FROM node@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg python3 python3-cryptography git build-essential pkg-config libssl-dev \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl --fail --silent --show-error https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /tmp/pgdg.asc \
    # One primary key, and it is the PostgreSQL apt repository's (IN-12, 15 November 2026).
    && export GNUPGHOME="$(mktemp -d)" \
    && gpg --batch --show-keys --with-colons /tmp/pgdg.asc \
       | awk -F: '$1 == "pub" { n++ } $1 == "fpr" && !f { f = $10 } END { exit !(n == 1 && f == "B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8") }' \
    && rm -rf "$GNUPGHOME" && unset GNUPGHOME \
    && install -m 0644 /tmp/pgdg.asc /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc && rm /tmp/pgdg.asc \
    && echo 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main' > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends postgresql-client-17 \
    && rm -rf /var/lib/apt/lists/*
