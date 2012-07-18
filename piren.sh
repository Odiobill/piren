#!/bin/sh
#
# piren.sh 201207171412
# Davide Lucchesi <davide@lucchesi.nl>
#
# configure live-build for generating a Piren image in the current directory
#
# You can provide extra live-build parameters listing them on the command
# line for this script.
#

# standard parameters used for live-build
#
lb config  \
	--bootappend-live "hostname=piren username=xbmc"  \
	--apt-recommends false --apt-indices false  \
	--memtest none --includes none  \
	--debian-installer live --debian-installer-gui false  \
	--archives live.debian.net  \
	--distribution wheezy --archive-areas "main contrib non-free"  \
	--iso-application "Piren"  \
	--iso-publisher "http://piren.org/"  \
	--iso-volume "Piren" $@

# add Piren's includes/hooks/customizations
#
cp -r $(dirname $0)/includes/* config/

# remove unwanted packages to make Piren as thin as possible with a hook script
#
chmod 755 config/hooks/slimmer.chroot

# ensure that /var/tmp will be present on the system once installed
#
mkdir -p config/includes.chroot/var/tmp
chmod ugo+rwxt config/includes.chroot/var/tmp

# same for /var/log/fsck
mkdir -p config/includes.chroot/var/log/fsck

# define xbmc as default window manager, so the live image starts it up on boot
#
mkdir -p config/includes.chroot/usr/bin
ln -s /usr/bin/xbmc-standalone config/includes.chroot/usr/bin/x-window-manager

# to execute xbmc on boot once Piren is installed, active the init script and
# reconfigure X to allow anybody to start the environment even if not logged,
# using the included config/preseed/piren.preseed.chroot for the live image 
#
chmod 755 config/includes.chroot/etc/init.d/xbmc

# debian-installer is customized as well using a different pressed file:
# 	config/binary_debian-installer/preseed.cfg
#
# by default, it ensures that the new user name is created with predefined
# parameters (i.e. "xbmc" as username), and it configures the included init
# script to be activated as system service

