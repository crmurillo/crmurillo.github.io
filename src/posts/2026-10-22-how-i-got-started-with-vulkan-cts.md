---
title: How I got started with Vulkan CTS
description: How a tile-unit bug in the Vulkan Video Samples AV1 parser led to my first Vulkan CTS tests, and what I learned writing them.
tags: [blog]
draft: false
---

This year I started working on Vulkan Video and the Vulkan Conformance Test Suite (CTS) as part of my role as a *multimedia developer* at [Igalia](https://www.igalia.com/). I'm also a member of the Khronos Vulkan Video Technical Subgroup (TSG), the group that develops the Vulkan Video extensions.

I want to share in a blog *series* what I've learned along the way, starting from my first task: write the conformance tests to identify a parser bug.

## CTS in one paragraph

The Vulkan Conformance Test Suite is necessary to verify whether a Vulkan driver is conformant with regards to the specification. It lives in the [VK-GL-CTS](https://github.com/KhronosGroup/VK-GL-CTS) repository, alongside tests for other graphics APIs like OpenGL and OpenGL ES. It is built on a framework called *drawElements Quality Program (dEQP)*. Hence the prefix `dEQP-VK` seen in the test cases. The video tests live under `dEQP-VK.video.*`, where I focus the most.

## The problem
My first task started with a bug in [Vulkan Video Samples](https://github.com/KhronosGroup/Vulkan-Video-Samples), a set of sample applications from the Khronos Group. Its parser library is used by CTS for the decode tests. 

According to the AV1 specification, a frame can be broken into tiles that can be decoded independently of each other, allowing decoders to process them in parallel. Tiles are divided internally into a matrix of superblocks (SB), square regions of 64x64 or 128x128 luma samples. At the bottom of this hierarchy is the mode info (MI) unit, a 4x4 block of luma samples.

The following example shows a frame split into 2x2 tiles, with superblocks of size 64x64 luma samples. The start column and start row of a tile are specified in MI units, in `MiColStarts` and `MiRowStarts` respectively.

```
  A frame, split into 2×2 tiles

         Tile 0            Tile 1
         0     1     2     3     4     5            ← superblock column index
         ↓                 ↓
   0  →  ┌─────┬─────┬─────╥─────┬─────┬─────┐
         │ SB  │ SB  │ SB  ║ SB  │ SB  │ SB  │
  16     ├─────┼─────┼─────╫─────┼─────┼─────┤      SB = superblock (64×64 pixels)
         │ SB  │ SB  │ SB  ║ SB  │ SB  │ SB  │
  32  →  ╞═════╪═════╪═════╬═════╪═════╪═════╡      ═ ║  tile boundary
         │ SB  │ SB  │ SB  ║ SB  │ SB  │ SB  │      ─ │  superblock boundary
  48     ├─────┼─────┼─────╫─────┼─────┼─────┤
         │ SB  │ SB  │ SB  ║ SB  │ SB  │ SB  │
  64     └─────┴─────┴─────╨─────┴─────┴─────┘
   ↑     0     16    32    48    64    80    96     ← MI column
MI row                                          
```

For example, for Tile 1:
```
  MiColStarts[1] = 3 SB × 16 MI = 48
  MiRowStarts[0] = 0 SB × 16 MI = 0

  1 SB = 64 pixels = 64 ÷ 4 = 16 MI
```

When an application asks a Vulkan driver to decode an AV1 frame, it passes the tile information in a struct called `StdVideoAV1TileInfo`, which contains the fields `pMiColStarts` and `pMiRowStarts` corresponding to `MiColStarts` and `MiRowStarts` in the AV1 specification. For Tile 1, the driver received a start column of 3 instead of 48, since the Vulkan Video Samples parser assigned `MiColStarts` as follows (and the same for `MiRowStarts`):

```cpp
pic_data->MiColStarts[i] = start_sb;
```

The parser was passing superblock indices instead of MI units (Thanks [@zzoon](https://blogs.igalia.com/zzoon/) for reporting and fixing it! [Issue #152](https://github.com/KhronosGroup/Vulkan-Video-Samples/issues/152)).

A driver doesn't actually need the application to provide `MiColStarts` and `MiRowStarts`. It already has enough information to calculate the tile starts from the tile sizes, the superblock size and the frame dimensions. That's exactly what the Vulkan specification now recommends in a note added in version 1.4.344:

> "Historically some applications incorrectly specified the values in `pMiColStarts` and `pMiRowStarts` in terms of superblocks instead of mode info blocks, therefore it is recommended for implementations to ignore the values specified in `pMiColStarts` and `pMiRowStarts`. Instead, the values should be calculated based on `flags.uniform_tile_spacing_flag`, `pWidthInSbsMinus1`, `pHeightInSbsMinus1`, the sequence header parameter `flags.use_128x128_superblock`, and the coded extent of the decoded picture."[1]

Mesa's RADV[2] and ANV[3] drivers now follow this recommendation.

Fixing the parser and the drivers solves part of the problem. But other applications might still be sending superblock units, and those applications will only work on drivers that ignore the fields. My task was to write a CTS test that checks whether a driver ignores them.

## The tests

CTS decodes video with the same parser as Vulkan Video Samples, which after the fix sends tile starts in the correct unit, MI. Therefore, the existing AV1 decode tests already cover correct usage: the driver gets the right values, and the decoded frames must match. What was missing was an additional test for incorrect usage, a test that still sends superblock units.

For that, I added an option to the CTS decoder, `ForceSbTileUnits`. If enabled, it converts the tile starts back into superblock units right before each frame is submitted.

```cpp
const uint32_t sbShift = seq->flags.use_128x128_superblock ? 5u : 4u;

for (uint32_t i = 0; i < p->tileInfo.TileCols; ++i)
    p->MiColStarts[i] = static_cast<uint16_t>(p->MiColStarts[i] >> sbShift);
for (uint32_t i = 0; i < p->tileInfo.TileRows; ++i)
    p->MiRowStarts[i] = static_cast<uint16_t>(p->MiRowStarts[i] >> sbShift);
```

If the clip is single tile, every start is 0, and 0 is the same in either unit, so the test wouldn't check anything. For this reason, it's important to test on clips with multiple tiles.

Every decoded frame is hashed and compared against a known-good checksum. In the existing AV1 tests, which send MI units, a mismatch is a failure. In the new tests, which send superblock units, there are two possible outcomes:
- Pass: the driver ignores the superblock values, as the specification note recommends, and decodes the same frames as the existing test.
- QualityWarning: the driver reads the values as MI units, places the tiles in the wrong positions, and the checksums don't match.

It's a warning and not a failure because ignoring these fields is only a recommendation, not a requirement. A driver that trusts those fields is still conformant. The goal is to push drivers to accept both units, so they keep working with applications that still send the wrong units.

## What I learned

- **One test is really several.** Every decode test runs in four variants: the decoded picture buffer (DPB) is either layered or separated, and images use either general or video-specific layouts. Two clips × four variants gave me eight new test cases, with names like:

  ```
  dEQP-VK.video.decode.av1.svcl1t2_8_sb_tile_units_layered_dpb_general_layout
  dEQP-VK.video.decode.av1.argon_filmgrain_10_test1019_sb_tile_units_separated_dpb_video_layout
  ```

- **New tests go in the mustpass list.** That's the list of tests a driver has to run to be conformant. Despite the name, not every test has to pass: on a driver without AV1 decode support, these tests report `NotSupported`, and that's fine. A `QualityWarning` is also an accepted result. It doesn't block conformance, but it shows up in the results for driver developers to see.

Hunting bugs and developing tests to catch them can lead you through the whole stack: from the AV1 and Vulkan specifications, to the sample application and CTS, down to the drivers.


## References

[1] [https://docs.vulkan.org/spec/latest/chapters/videocoding.html#_av1_decoding_parameters](https://docs.vulkan.org/spec/latest/chapters/videocoding.html#_av1_decoding_parameters)

[2] [https://gitlab.freedesktop.org/mesa/mesa/-/merge_requests/39492](https://gitlab.freedesktop.org/mesa/mesa/-/merge_requests/39492)

[3] [https://gitlab.freedesktop.org/mesa/mesa/-/merge_requests/39471](https://gitlab.freedesktop.org/mesa/mesa/-/merge_requests/39471)
