#!/usr/bin/env bun
// audiobook.ts
//
// This Bun program takes an MP3 file as input, detects quiet sections to mark chapters,
// and converts it to an M4B audiobook file with embedded chapters.
//
// Usage:
//   bun audiobook.ts <input.mp3> [--noise -30dB] [--duration 2]
//
// For example:
//   bun audiobook.ts myAudio.mp3 --noise -35dB --duration 3

import { existsSync, writeFileSync } from "fs";
import { exit } from "process";

// Get command-line arguments. Bun.argv includes the script name.
const args = Bun.argv.slice(2);

let inputFile = "";
let noiseThreshold = "-30dB"; // default noise threshold
let silenceDuration = 2;       // default minimum silence duration (seconds)

// Simple command-line argument parsing.
if (args.length === 0) {
  console.error("Usage: bun audiobook.ts <input.mp3> [--noise -30dB] [--duration 2]");
  exit(1);
}

for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    if (args[i] === "--noise") {
      noiseThreshold = args[i + 1];
      i++;
    } else if (args[i] === "--duration") {
      silenceDuration = parseFloat(args[i + 1]);
      i++;
    } else {
      console.error("Unknown option:", args[i]);
      exit(1);
    }
  } else {
    // First non-option argument is the input file.
    if (!inputFile) {
      inputFile = args[i];
    }
  }
}

if (!inputFile) {
  console.error("Please specify an input MP3 file.");
  exit(1);
}

if (!existsSync(inputFile)) {
  console.error(`Input file "${inputFile}" does not exist.`);
  exit(1);
}

console.log(`Processing file: ${inputFile}`);
console.log(`Silence detection parameters: noise=${noiseThreshold}, duration=${silenceDuration} sec`);

// Wrap everything in an async function so we can use await.
async function main() {
  // 1. Run ffmpeg with silencedetect.
  const silenceCmd = [
    "ffmpeg",
    "-i", inputFile,
    "-af", `silencedetect=noise=${noiseThreshold}:d=${silenceDuration}`,
    "-f", "null",
    "-"
  ];
  console.log(`Running: ${silenceCmd.join(" ")}`);

  const silenceProc = Bun.spawn({
    cmd: silenceCmd,
    stdout: "pipe",
    stderr: "pipe"
  });

  // ffmpeg writes silencedetect output to stderr.
  const silenceStdoutBuffer = await silenceProc.stdout.arrayBuffer();
  const silenceStderrBuffer = await silenceProc.stderr.arrayBuffer();
  const silenceStdout = new TextDecoder().decode(silenceStdoutBuffer);
  const silenceStderr = new TextDecoder().decode(silenceStderrBuffer);

  // 2. Parse silence detection output.
  const silenceStarts: number[] = [];
  const silenceEnds: number[] = [];
  const silenceStartRegex = /silence_start:\s*(\d+\.?\d*)/g;
  const silenceEndRegex = /silence_end:\s*(\d+\.?\d*)/g;
  let match: RegExpExecArray | null;
  while ((match = silenceStartRegex.exec(silenceStderr)) !== null) {
    silenceStarts.push(parseFloat(match[1]));
  }
  while ((match = silenceEndRegex.exec(silenceStderr)) !== null) {
    silenceEnds.push(parseFloat(match[1]));
  }

  console.log("Detected silence start times:", silenceStarts);
  console.log("Detected silence end times:", silenceEnds);

  // 3. Use ffprobe to get the total duration (in seconds) of the input file.
  const ffprobeCmd = [
    "ffprobe",
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    inputFile
  ];
  console.log(`Running: ${ffprobeCmd.join(" ")}`);
  const ffprobeProc = Bun.spawn({
    cmd: ffprobeCmd,
    stdout: "pipe",
    stderr: "pipe"
  });
  const probeStdoutBuffer = await ffprobeProc.stdout.arrayBuffer();
  const probeStdout = new TextDecoder().decode(probeStdoutBuffer).trim();
  const totalDuration = parseFloat(probeStdout);
  console.log(`Total duration: ${totalDuration} seconds`);

  // 4. Create chapter markers.
  // We create the first chapter at time 0 and then a new chapter for each silence end.
  const chapters: { start: number; title: string }[] = [];
  chapters.push({ start: 0, title: "Chapter 1" });
  silenceEnds.forEach((time, index) => {
    chapters.push({ start: time, title: `Chapter ${index + 2}` });
  });

  // 5. Generate the ffmetadata file (times in milliseconds).
  let metadata = ";FFMETADATA1\n";
  for (let i = 0; i < chapters.length; i++) {
    metadata += "[CHAPTER]\nTIMEBASE=1/1000\n";
    const startMs = Math.floor(chapters[i].start * 1000);
    metadata += `START=${startMs}\n`;
    let endMs: number;
    if (i < chapters.length - 1) {
      endMs = Math.floor(chapters[i + 1].start * 1000) - 1;
    } else {
      endMs = Math.floor(totalDuration * 1000);
    }
    metadata += `END=${endMs}\n`;
    metadata += `title=${chapters[i].title}\n\n`;
  }

  const metadataFile = "chapters.txt";
  writeFileSync(metadataFile, metadata);
  console.log(`Chapter metadata written to ${metadataFile}`);

  // 6. Convert the MP3 to an M4B file with chapters.
  const outputFile = inputFile.replace(/\.mp3$/i, ".m4b");
  const convertCmd = [
    "ffmpeg",
    "-i", inputFile,
    "-i", metadataFile,
    "-map_metadata", "1",
    "-c", "copy",
    outputFile
  ];
  console.log(`Running: ${convertCmd.join(" ")}`);
  const convertProc = Bun.spawn({
    cmd: convertCmd,
    stdout: "inherit",
    stderr: "inherit"
  });
  const convertResult = await convertProc.exited;

  if (convertResult.code === 0) {
    console.log(`Successfully created ${outputFile} with chapters.`);
  } else {
    console.error("Error during conversion.");
    exit(1);
  }
}

main().catch(err => {
  console.error("Error:", err);
  exit(1);
});
