#!/usr/bin/env python3
# Linux EFI zboot header: drivers/firmware/efi/libstub/zboot-header.S.
import pathlib, struct, zlib
base=pathlib.Path(__file__).resolve().parent.parent/'vm'
data=(base/'desktop-rootfs/boot/vmlinuz-virt').read_bytes()
if data[4:8]==b'zimg':
 offset,length=struct.unpack_from('<II',data,8)
 if data[24:29]!=b'gzip\0' or offset+length>len(data): raise ValueError('Unsupported EFI zboot payload')
 data=zlib.decompress(data[offset:offset+length],31)
if data[56:60]!=b'ARMd': raise ValueError('Kernel does not have the ARM64 boot header')
(base/'desktop-Image').write_bytes(data)
print('ARM64 kernel:',len(data),'bytes')
