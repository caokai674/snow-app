#!/bin/sh
set -eu

host_key=/host-keys/ssh_host_ed25519_key
if [ ! -f "$host_key" ]; then
  ssh-keygen -q -t ed25519 -N '' -f "$host_key"
fi

chmod 600 "$host_key"
chown snow:snow /home/snow/.ssh
chmod 700 /home/snow/.ssh
if [ -f /run/snow-authorized-keys ]; then
  install -o snow -g snow -m 600 /run/snow-authorized-keys /home/snow/.ssh/authorized_keys
fi

exec /usr/sbin/sshd -D -e -p 2222 \
  -h "$host_key" \
  -o PasswordAuthentication=yes \
  -o PubkeyAuthentication=yes \
  -o AuthorizedKeysFile=.ssh/authorized_keys \
  -o PermitRootLogin=no \
  -o UsePAM=no
