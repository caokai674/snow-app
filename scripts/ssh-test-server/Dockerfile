ARG DEBIAN_SUITE
FROM debian:${DEBIAN_SUITE}-slim

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server tmux \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --shell /bin/sh snow \
  && echo 'snow:snow-test-password' | chpasswd \
  && mkdir -p /run/sshd /host-keys /home/snow/.ssh \
  && chmod 700 /home/snow/.ssh \
  && chown -R snow:snow /home/snow

COPY entrypoint.sh /usr/local/bin/snow-ssh-test-server
RUN chmod 755 /usr/local/bin/snow-ssh-test-server

EXPOSE 2222
ENTRYPOINT ["/usr/local/bin/snow-ssh-test-server"]
