#!/usr/bin/env bun
//
// audiobook.ts
//
// This Bun program takes a file as input (ideally MP3 or any audio), detects quiet sections
// to mark chapters, and converts it to an M4B audiobook file with embedded chapters.
//
// Usage:
//   bun audiobook.ts <input-file> [--noise -30dB] [--duration 2]
//
// For example:
//   bun audiobook.ts myAudio.mp4 --noise -35dB --duration 3
//   bun audiobook.ts myAudio.mp3 --noise -35dB --duration 3
//

import { existsSync, writeFileSync } from "fs";
import { exit } from "process";

// -----------------------------------------------------------------------------
// 1. Parse Command-Line Arguments
// -----------------------------------------------------------------------------
const args = Bun.argv.slice(2);

let inputFile = "";
let noiseThreshold = "-30dB"; // default noise threshold
let silenceDuration = 2;      // default minimum silence duration (seconds)

if (args.length === 0) {
  console.error("Usage: bun audiobook.ts <input-file> [--noise -30dB] [--duration 2]");
  exit(1);
}

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg.startsWith("--")) {
    switch (arg) {
      case "--noise":
        noiseThreshold = args[i + 1];
        i++;
        break;
      case "--duration":
        silenceDuration = parseFloat(args[i + 1]);
        i++;
        break;
      default:
        console.error("Unknown option:", arg);
        exit(1);
    }
  } else {
    // First non-option argument is the input file.
    if (!inputFile) {
      inputFile = arg;
    }
  }
}

if (!inputFile) {
  console.error("Please specify an input audio/video file.");
  exit(1);
}

if (!existsSync(inputFile)) {
  console.error(`Input file "${inputFile}" does not exist.`);
  exit(1);
}

// -----------------------------------------------------------------------------
// 2. Main Execution
// -----------------------------------------------------------------------------
async function main() {
  console.log(`\n--- Audiobook Conversion ---`);
  console.log(`Input file: ${inputFile}`);
  console.log(`Noise threshold: ${noiseThreshold}`);
  console.log(`Silence duration: ${silenceDuration}s\n`);

  // ---------------------------------------------------------------------------
  // 2.1. Run ffmpeg with silencedetect
  // ---------------------------------------------------------------------------
  const silenceCmd = [
    "ffmpeg",
    "-i",
    inputFile,
    "-af",
    `silencedetect=n=${noiseThreshold}:d=${silenceDuration}`,
    "-f",
    "null",
    "-"
  ];

  console.log(`Running silencedetect command:\n  ${silenceCmd.join(" ")}`);

  const silenceProc = Bun.spawnSync({
    cmd: silenceCmd,
    stdout: "pipe",
    stderr: "pipe"
  });

  const silenceStdout = new TextDecoder().decode(silenceProc.stdout);
  const silenceStderr = new TextDecoder().decode(silenceProc.stderr);

  if (silenceProc.exitCode !== 0) {
    console.error("ffmpeg silencedetect failed. Output:");
    console.error(silenceStderr);
    exit(1);
  }

  // ---------------------------------------------------------------------------
  // 2.2. Parse Silence Detection Output
  // ---------------------------------------------------------------------------
  const silenceStarts: number[] = [];
  const silenceEnds: number[] = [];

  const silenceStartRegex = /silence_start:\s*([\d.]+)/g;
  const silenceEndRegex = /silence_end:\s*([\d.]+)/g;

  let match: RegExpExecArray | null;

  while ((match = silenceStartRegex.exec(silenceStderr)) !== null) {
    silenceStarts.push(parseFloat(match[1]));
  }

  while ((match = silenceEndRegex.exec(silenceStderr)) !== null) {
    silenceEnds.push(parseFloat(match[1]));
  }

  console.log("\nDetected silence start times:", silenceStarts);
  console.log("Detected silence end times:", silenceEnds);

  // ---------------------------------------------------------------------------
  // 2.3. Get Total Duration via ffprobe
  // ---------------------------------------------------------------------------
  const ffprobeCmd = [
    "ffprobe",
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    inputFile
  ];

  console.log(`\nRunning ffprobe command:\n  ${ffprobeCmd.join(" ")}`);

  const ffprobeProc = Bun.spawnSync({
    cmd: ffprobeCmd,
    stdout: "pipe",
    stderr: "pipe"
  });

  if (ffprobeProc.exitCode !== 0) {
    console.error("ffprobe failed to retrieve duration.");
    console.error(new TextDecoder().decode(ffprobeProc.stderr));
    exit(1);
  }

  const probeBuffer = ffprobeProc.stdout;
  const totalDuration = parseFloat(new TextDecoder().decode(probeBuffer).trim());

  if (isNaN(totalDuration)) {
    console.error("Could not parse the total duration from ffprobe output.");
    exit(1);
  }

  console.log(`Total duration: ${totalDuration.toFixed(2)} seconds\n`);

  // ---------------------------------------------------------------------------
  // 2.4. Create Chapter Markers
  // ---------------------------------------------------------------------------
  // First chapter starts at 0.
  // Then each subsequent silenceEnd becomes the start of a new chapter.
  // The last chapter ends at totalDuration.
  const chapters: { start: number; title: string }[] = [];
  chapters.push({ start: 0, title: "Chapter 1" });

  silenceEnds.forEach((time, index) => {
    chapters.push({ start: time, title: `Chapter ${index + 2}` });
  });

  // ---------------------------------------------------------------------------
  // 2.5. Generate Chapter Metadata File (FFmetadata format)
  // ---------------------------------------------------------------------------
  // Times are in milliseconds in FFMETADATA.
  let metadata = ";FFMETADATA1\n";

  for (let i = 0; i < chapters.length; i++) {
    const startMs = Math.floor(chapters[i].start * 1000);
    const endMs =
      i < chapters.length - 1
        ? Math.floor(chapters[i + 1].start * 1000) - 1
        : Math.floor(totalDuration * 1000);

    metadata += `[CHAPTER]\n`;
    metadata += `TIMEBASE=1/1000\n`;
    metadata += `START=${startMs}\n`;
    metadata += `END=${endMs}\n`;
    metadata += `title=${chapters[i].title}\n\n`;
  }

  const metadataFile = "chapters.txt";
  writeFileSync(metadataFile, metadata);
  console.log(`Chapter metadata written to: ${metadataFile}`);

  // ---------------------------------------------------------------------------
  // 2.6. Convert to M4B with Chapters (Re-encode audio, remove video)
  // ---------------------------------------------------------------------------
  const outputFile = inputFile.replace(/\.[^.]+$/, "") + ".m4b";
  const convertCmd = [
    "ffmpeg",
    "-y",                  // Overwrite existing files
    "-i", inputFile,
    "-i", metadataFile,
    "-map_metadata", "1",
    "-vn",                 // Ignore/remove any video streams
    "-c:a", "aac",         // Encode audio as AAC
    "-b:a", "128k",        // Bitrate (adjust as needed)
    outputFile
  ];

  console.log(`\nRunning conversion command:\n  ${convertCmd.join(" ")}`);

  const convertProc = Bun.spawnSync({
    cmd: convertCmd,
    stdout: "inherit",
    stderr: "inherit"
  });

  if (convertProc.exitCode === 0) {
    console.log(`\nSuccessfully created M4B file: ${outputFile}`);
  } else {
    console.error("Error during conversion. Please check the output above.");
    exit(1);
  }
}

// Run the main function, catch any unhandled errors
main().catch((err) => {
  console.error("Unhandled Error:", err);
  exit(1);
});
