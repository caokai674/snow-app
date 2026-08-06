#!/bin/sh
set -eu

mkdir -p /run/sshd

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

if [ "$INSTALL_SYSTEMD_USER" = "1" ] && [ "${1:-}" != "--systemd-service" ]; then
  exec /lib/systemd/systemd
fi

if [ "$INSTALL_SYSTEMD_USER" = "1" ]; then
  runtime_dir="/run/user/$(id -u snow)"
  systemctl start "user@$(id -u snow).service"
  ready=0
  for _ in $(seq 1 40); do
    if runuser -u snow -- env \
      XDG_RUNTIME_DIR="$runtime_dir" \
      DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime_dir/bus" \
      systemctl --user show-environment >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 0.1
  done
  [ "$ready" = "1" ] || exit 1
fi

exec /usr/sbin/sshd -D -e -p 2222 \
  -h "$host_key" \
  -o PasswordAuthentication=yes \
  -o PubkeyAuthentication=yes \
  -o AuthorizedKeysFile=.ssh/authorized_keys \
  -o PermitRootLogin=no \
  -o UsePAM=no
