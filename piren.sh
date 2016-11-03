#!/bin/sh
#
# piren.sh - 15.6.27
# Author: Davide Lucchesi <davide@lucchesi.nl>
#
# You need a Debian system with live-build installed.
#

lb config \
	--apt-options "--yes --force-yes" \
	--apt-indices false --apt-recommends false \
	--debootstrap-options "--variant=minbase" \
	--firmware-chroot false \
	--memtest none \
	--debian-installer live --debian-installer-gui false \
	--iso-publisher "http://piren.org/" \
	--iso-volume Piren\ `date +"%y.%_m.%_d" | sed "s/ //"`

echo "\
	ifupdown \
	netbase \
	sudo \
	udhcpc \
	user-setup" \
> config/package-lists/base.list.chroot

echo "\
	deb-multimedia-keyring \
	kodi-standalone \
	kodi-pvr-iptvsimple \
	libcurl3-gnutls \
	libegl1-mesa-drivers \
	libgl1-mesa-dri \
	mesa-vdpau-drivers \
	nodm \
	pulseaudio \
	xinit \
	xserver-xorg" \
> config/package-lists/kodi.list.chroot

echo \
	"deb http://www.deb-multimedia.org jessie main non-free" \
> config/archives/deb-multimedia.list.chroot
echo \
	"deb http://www.deb-multimedia.org jessie-backports main" \
>> config/archives/deb-multimedia.list.chroot

mkdir -p config/includes.chroot/etc/apt/sources.list.d
echo \
	"deb http://www.deb-multimedia.org jessie main non-free" \
> config/includes.chroot/etc/apt/sources.list.d/deb-multimedia.list
echo \
	"deb http://www.deb-multimedia.org jessie-backports main" \
>> config/includes.chroot/etc/apt/sources.list.d/deb-multimedia.list

# live
mkdir -p config/includes.chroot/home/user
echo "/usr/bin/kodi-standalone" > config/includes.chroot/home/user/.xsession

# installed
mkdir -p config/includes.chroot/root
echo "/usr/bin/kodi-standalone" > config/includes.chroot/root/.xsession

mkdir -p config/includes.chroot/etc/default
cat <<EOF > config/includes.chroot/etc/default/nodm
NODM_ENABLED=true
NODM_USER=root
NODM_FIRST_VT=7
NODM_XSESSION=/etc/X11/Xsession
NODM_X_OPTIONS='-nolisten tcp'
NODM_MIN_SESSION_TIME=60
EOF

mkdir -p cache/contents.chroot

mkdir -p config/includes.binary/isolinux
if [ -f "splash.png" ]; then
	cp splash.png config/includes.binary/isolinux/
fi

cat <<EOF > config/includes.binary/isolinux/menu.cfg
menu hshift 0
menu width 82

menu title Boot menu
include stdmenu.cfg
include live.cfg

label install
	menu label ^Install
	linux /install/vmlinuz
	initrd /install/initrd.gz
	append vga=788  -- quiet

menu clear
EOF

lb build 2>&1 | tee build.log

