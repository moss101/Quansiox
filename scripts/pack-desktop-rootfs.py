#!/usr/bin/env python3
"""Write a deterministic newc initramfs without requiring root or mknod on macOS."""
import gzip, os, pathlib, stat
root=pathlib.Path(__file__).resolve().parent.parent/'vm/desktop-rootfs'
out=root.parent/'desktop-initramfs.cpio.gz.next'
excluded={'boot','proc','sys','dev','share','tmp','run'}
paths=[root]
for directory, children, files in os.walk(root):
 if pathlib.Path(directory)==root: children[:]=sorted(name for name in children if name not in excluded)
 else: children.sort()
 for name in sorted(children+files): paths.append(pathlib.Path(directory)/name)
# Empty mount points are required; their contents come from the guest kernel.
for name in sorted(excluded): (root/name).mkdir(exist_ok=True)
paths.extend(root/name for name in sorted(excluded))
with out.open('wb') as raw, gzip.GzipFile(filename='',fileobj=raw,mode='wb',compresslevel=3,mtime=0) as target:
 for inode,p in enumerate(paths+[None],1):
  if p is None: name='TRAILER!!!'; mode=0; size=0; link=b''
  else:
   st=p.lstat(); name='.' if p==root else './'+str(p.relative_to(root)); mode=st.st_mode
   link=os.fsencode(os.readlink(p)) if stat.S_ISLNK(mode) else b''
   size=len(link) if link else st.st_size if stat.S_ISREG(mode) else 0
  encoded=os.fsencode(name)+b'\0'
  fields=[inode,mode,0,0,1,0,size,0,0,0,0,len(encoded),0]
  header=b'070701'+b''.join(('%08x'%field).encode() for field in fields)
  target.write(header+encoded); target.write(b'\0'*((-len(header)-len(encoded))%4))
  if link: target.write(link)
  elif size:
   with p.open('rb') as source:
    while True:
     block=source.read(1024*1024)
     if not block: break
     target.write(block)
  target.write(b'\0'*((-size)%4))
os.replace(out,root.parent/'desktop-initramfs.cpio.gz')
print('Packed guest desktop:',(root.parent/'desktop-initramfs.cpio.gz').stat().st_size,'bytes')
