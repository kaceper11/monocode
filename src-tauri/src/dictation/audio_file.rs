//! WAV input for the diagnostics path (`dictation_transcribe_file`) and the
//! `dictation-bench` binary — decode, downmix to mono, resample to 16 kHz.

use std::path::Path;

use super::resample::{Resampler, WHISPER_RATE};

/// Diagnostics are for short clips; bound decoded duration so a large file
/// can't OOM the process through an IPC-reachable command.
const MAX_FILE_SECONDS: u64 = 30 * 60;

pub fn read_wav_mono(path: &Path) -> Result<Vec<f32>, String> {
    let mut reader = hound::WavReader::open(path)
        .map_err(|e| format!("Cannot read audio file {}: {e}", path.display()))?;
    let spec = reader.spec();
    // A bogus rate (e.g. 0) would make the resampler emit thousands of
    // output samples per input sample — a small file could OOM the process.
    if !(4_000..=768_000).contains(&spec.sample_rate) {
        return Err(format!("Unsupported sample rate {} Hz", spec.sample_rate));
    }
    let channels = spec.channels as usize;
    if !(1..=32).contains(&channels) {
        return Err("Unsupported audio channel count".into());
    }
    let max_frames = spec.sample_rate as u64 * MAX_FILE_SECONDS;
    if reader.duration() as u64 > max_frames {
        return Err("Audio file is too long for dictation diagnostics".into());
    }
    let samples: Box<dyn Iterator<Item = Result<f32, hound::Error>> + '_> = match spec.sample_format
    {
        hound::SampleFormat::Float if spec.bits_per_sample == 32 => {
            Box::new(reader.samples::<f32>())
        }
        hound::SampleFormat::Int if (1..=32).contains(&spec.bits_per_sample) => {
            let scale = (1u64 << (spec.bits_per_sample - 1)) as f32;
            Box::new(
                reader
                    .samples::<i32>()
                    .map(move |sample| sample.map(|value| value as f32 / scale)),
            )
        }
        _ => return Err("Unsupported audio sample format".into()),
    };
    // Stream/downmix before resampling: high-rate multichannel files never
    // require a whole decoded input buffer in addition to the 16kHz output.
    let mut mono = Vec::with_capacity(2048);
    let mut out = Vec::new();
    let mut resampler = Resampler::new(spec.sample_rate, WHISPER_RATE);
    let mut sum = 0.0f32;
    let mut count = 0u64;
    for sample in samples {
        let sample = sample.map_err(|error| format!("Cannot decode audio: {error}"))?;
        if !sample.is_finite() {
            return Err("Audio contains non-finite samples".into());
        }
        count += 1;
        if count > max_frames * channels as u64 {
            return Err("Audio file is too long for dictation diagnostics".into());
        }
        sum += sample.clamp(-1.0, 1.0);
        if count.is_multiple_of(channels as u64) {
            mono.push(sum / channels as f32);
            sum = 0.0;
            if mono.len() == 2048 {
                resampler.process(&mono, &mut out);
                mono.clear();
            }
        }
    }
    if !count.is_multiple_of(channels as u64) {
        return Err("Audio ends in an incomplete frame".into());
    }
    resampler.process(&mono, &mut out);
    resampler.finish(&mut out);
    Ok(out)
}

/// Write 16 kHz mono f32 as 16-bit PCM WAV — used by tests and tooling.
#[cfg(test)]
pub fn write_wav_mono(path: &Path, samples: &[f32]) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: WHISPER_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec)
        .map_err(|e| format!("Cannot write audio file {}: {e}", path.display()))?;
    for sample in samples {
        let clamped = sample.clamp(-1.0, 1.0);
        writer
            .write_sample((clamped * i16::MAX as f32) as i16)
            .map_err(|e| format!("Cannot write audio: {e}"))?;
    }
    writer
        .finalize()
        .map_err(|e| format!("Cannot write audio file: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_roundtrip_16k_mono() {
        let dir = std::env::temp_dir().join(format!(
            "monocode-wav-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sine.wav");
        let input: Vec<f32> = (0..1600)
            .map(|i| (2.0 * std::f64::consts::PI * 440.0 * i as f64 / 16000.0).sin() as f32)
            .collect();
        write_wav_mono(&path, &input).unwrap();
        let decoded = read_wav_mono(&path).unwrap();
        assert_eq!(decoded.len(), input.len());
        let max_err = decoded
            .iter()
            .zip(input.iter())
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        assert!(max_err < 1.0 / 2048.0, "max_err {max_err}");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
