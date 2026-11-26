//! 음악 보관함의 파일들을 읽는다. 모두 사람이 손으로 고치는 글 파일이다.
//!
//! **곡 목록** (`songs.txt`): 등록한 곡마다 한 줄. 그 아래에 들여 쓴 줄들은 그 곡에 대한 글이다.
//!
//! ```text
//! https://youtu.be/영상번호 | 제목 | 아티스트 | 앨범
//!     이 곡에 대해 쓰고 싶은 글.
//! ```
//!
//! **플레이리스트** (`playlists/*.md`): 글 한 편이 플레이리스트 하나다. 유튜브 주소만 적은 줄이 곡이고,
//! 그 아래의 글은 그 곡에 대한 이야기, 첫 곡보다 앞의 글은 소개글이다.
//!
//! ```text
//! # 비 오는 날
//! 날짜: 2026-11-26
//!
//! 소개글…
//!
//! https://youtu.be/영상번호
//! 이 곡을 고른 까닭…
//! ```

#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Song {
    /// 유튜브 영상의 번호
    pub id: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    /// 이 곡에 대한 글 (문단은 빈 줄로 나눈다)
    pub note: String,
}

/// 플레이리스트의 곡 하나와, 그 자리에 쓴 글
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Entry {
    pub id: String,
    pub text: String,
}

/// 글처럼 쓴 플레이리스트
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Post {
    pub title: String,
    pub date: Option<String>,
    /// 첫 곡보다 앞에 쓴 소개글
    pub intro: String,
    pub entries: Vec<Entry>,
}

/// 영상 번호에 쓰이는 글자인가
fn id_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_'
}

/// 유튜브 주소나 영상 번호에서 번호를 뽑는다. 알아볼 수 없으면 `None`.
pub fn video_id(text: &str) -> Option<String> {
    let text = text.trim();
    let from_marker = ["v=", "youtu.be/", "/embed/", "/shorts/", "/live/"].iter().find_map(|marker| text.find(marker).map(|at| &text[at + marker.len()..]));
    let candidate = match from_marker {
        Some(rest) => rest,
        // 주소가 아니면 통째로 번호여야 한다.
        None if !text.contains(['/', '.', ' ']) => text,
        None => return None,
    };
    let id: String = candidate.chars().take_while(|c| id_char(*c)).collect();
    (6..=20).contains(&id.len()).then_some(id)
}

/// 여러 줄의 글을 다듬는다: 앞뒤의 빈 줄을 떼고, 줄마다 앞뒤 공백을 뗀다.
fn tidy(lines: &[&str]) -> String {
    lines.iter().map(|line| line.trim()).collect::<Vec<_>>().join("\n").trim().to_string()
}

/// 곡 목록 파일을 읽는다. 알아볼 수 없는 줄은 건너뛴다.
pub fn parse_songs(text: &str) -> Vec<Song> {
    let mut songs: Vec<Song> = Vec::new();
    let mut note: Vec<&str> = Vec::new();
    fn close(songs: &mut [Song], note: &mut Vec<&str>) {
        if let Some(song) = songs.last_mut() {
            song.note = tidy(note);
        }
        note.clear();
    }
    for line in text.lines() {
        if line.trim_start().starts_with("//") {
            continue;
        }
        // 들여 쓴 줄과, 글 사이의 빈 줄은 바로 위 곡의 글이다.
        if line.starts_with([' ', '\t']) || line.trim().is_empty() {
            if !songs.is_empty() {
                note.push(line);
            }
            continue;
        }
        let mut parts = line.split('|').map(str::trim);
        let Some(id) = parts.next().and_then(video_id) else { continue };
        close(&mut songs, &mut note);
        let mut field = || parts.next().filter(|p| !p.is_empty()).map(str::to_string);
        songs.push(Song { id, title: field(), artist: field(), album: field(), note: String::new() });
    }
    close(&mut songs, &mut note);
    songs
}

/// 줄이 통째로 유튜브 주소(또는 영상 번호)이면 그 번호. 목록 표시(-)가 앞에 있어도 된다.
fn track_line(line: &str) -> Option<String> {
    let line = line.trim();
    let line = line.strip_prefix("- ").unwrap_or(line).trim();
    if line.contains(' ') {
        return None;
    }
    // 글 속의 낱말을 곡으로 잘못 읽지 않도록, 주소이거나 번호의 길이(11자)가 맞아야 한다.
    let looks_like_one = line.contains("youtu") || (line.len() == 11 && line.chars().all(id_char) && line.chars().any(|c| c.is_ascii_digit() || c == '-' || c == '_'));
    looks_like_one.then(|| video_id(line)).flatten()
}

/// 플레이리스트 파일을 읽는다. 제목이 없으면 `fallback`(파일 이름)을 쓴다.
pub fn parse_post(text: &str, fallback: &str) -> Post {
    let mut post = Post { title: fallback.to_string(), ..Post::default() };
    let mut prose: Vec<&str> = Vec::new();
    let mut titled = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(id) = track_line(trimmed) {
            // 지금까지의 글은 앞 곡의 것(첫 곡이면 소개글)이다.
            match post.entries.last_mut() {
                Some(entry) => entry.text = tidy(&prose),
                None => post.intro = tidy(&prose),
            }
            prose.clear();
            post.entries.push(Entry { id, text: String::new() });
        } else if !titled && post.entries.is_empty() && trimmed.starts_with("# ") {
            post.title = trimmed[2..].trim().to_string();
            titled = true;
        } else if post.entries.is_empty() && post.date.is_none() && (trimmed.starts_with("날짜:") || trimmed.starts_with("date:")) {
            post.date = Some(trimmed.split_once(':').map_or("", |(_, d)| d).trim().to_string()).filter(|d| !d.is_empty());
        } else {
            prose.push(line);
        }
    }
    match post.entries.last_mut() {
        Some(entry) => entry.text = tidy(&prose),
        None => post.intro = tidy(&prose),
    }
    post
}

/// JSON 글에서 `"key": "값"`의 값을 꺼낸다 (유튜브의 답에서 제목과 작성자를 읽는 데 쓴다).
/// 온전한 JSON 해석기는 아니고, 맨 바깥에 있는 글 값 하나를 찾는 만큼만 한다.
pub fn json_string(json: &str, key: &str) -> Option<String> {
    let start = json.find(&format!("\"{key}\""))? + key.len() + 2;
    let rest = json[start..].trim_start().strip_prefix(':')?.trim_start().strip_prefix('"')?;
    let mut out = String::new();
    let mut chars = rest.chars();
    let mut high: Option<u32> = None;
    while let Some(c) = chars.next() {
        match c {
            '"' => return Some(out),
            '\\' => match chars.next()? {
                'n' => out.push('\n'),
                't' => out.push('\t'),
                'u' => {
                    let code = u32::from_str_radix(&chars.by_ref().take(4).collect::<String>(), 16).ok()?;
                    // 한 글자가 😀처럼 둘로 나뉘어 올 수 있다.
                    match (high.take(), code) {
                        (Some(high), 0xdc00..=0xdfff) => out.push(char::from_u32(0x10000 + ((high - 0xd800) << 10) + (code - 0xdc00))?),
                        (_, 0xd800..=0xdbff) => high = Some(code),
                        _ => out.push(char::from_u32(code)?),
                    }
                }
                other => out.push(other),
            },
            c => out.push(c),
        }
    }
    None
}

/// 초를 "3:07" 꼴로 적는다.
pub fn clock(seconds: f32) -> String {
    let total = seconds.max(0.0) as u32;
    if total >= 3600 {
        format!("{}:{:02}:{:02}", total / 3600, total / 60 % 60, total % 60)
    } else {
        format!("{}:{:02}", total / 60, total % 60)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_video_id_in_addresses() {
        for text in [
            "https://www.youtube.com/watch?v=jNQXAC9IVRw",
            "https://www.youtube.com/watch?list=x&v=jNQXAC9IVRw&t=3",
            "https://youtu.be/jNQXAC9IVRw?si=abc",
            "https://music.youtube.com/watch?v=jNQXAC9IVRw",
            "https://www.youtube.com/embed/jNQXAC9IVRw",
            "https://www.youtube.com/shorts/jNQXAC9IVRw",
            "  jNQXAC9IVRw ",
        ] {
            assert_eq!(video_id(text).as_deref(), Some("jNQXAC9IVRw"), "{text}");
        }
        assert_eq!(video_id("https://example.com/page"), None);
        assert_eq!(video_id("그냥 글"), None);
        assert_eq!(video_id("ab"), None);
    }

    #[test]
    fn reads_the_catalog_with_notes() {
        let songs = parse_songs(
            "// 설명\nhttps://youtu.be/first000001 | 하나 | 가수 | 첫 앨범\n    이 곡은 이렇다.\n\n    둘째 문단.\nsecond00002 | 둘 | 가수\nthird000003\n알 수 없는 줄\n\tfourth 아님\n",
        );
        assert_eq!(songs.len(), 3);
        assert_eq!(
            songs[0],
            Song { id: "first000001".into(), title: Some("하나".into()), artist: Some("가수".into()), album: Some("첫 앨범".into()), note: "이 곡은 이렇다.\n\n둘째 문단.".into() }
        );
        assert_eq!((songs[1].album.as_deref(), songs[1].note.as_str()), (None, ""));
        // 알아볼 수 없는 줄은 건너뛰고, 그 아래의 들여 쓴 글은 바로 위 곡의 것이 된다.
        assert_eq!((songs[2].title.as_deref(), songs[2].note.as_str()), (None, "fourth 아님"));
    }

    #[test]
    fn reads_a_playlist_written_like_a_post() {
        let post = parse_post(
            "# 비 오는 날\n날짜: 2026-11-26\n\n창밖을 보다가 골랐다.\n둘째 줄.\n\nhttps://youtu.be/first000001\n이 곡으로 시작한다.\n\n다음 문단.\n\n- https://www.youtube.com/watch?v=second00002\n\nthird_00003\n마지막 곡. youtube 라는 낱말이 든 글은 곡이 아니다.\n",
            "파일이름",
        );
        assert_eq!((post.title.as_str(), post.date.as_deref()), ("비 오는 날", Some("2026-11-26")));
        assert_eq!(post.intro, "창밖을 보다가 골랐다.\n둘째 줄.");
        assert_eq!(post.entries.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["first000001", "second00002", "third_00003"]);
        assert_eq!(post.entries[0].text, "이 곡으로 시작한다.\n\n다음 문단.");
        assert_eq!(post.entries[1].text, "");
        assert_eq!(post.entries[2].text, "마지막 곡. youtube 라는 낱말이 든 글은 곡이 아니다.");
        // 제목 줄이 없으면 파일 이름이 제목이다. 곡이 없으면 글 전체가 소개글이다.
        let bare = parse_post("그냥 글만 있다.", "밤");
        assert_eq!((bare.title.as_str(), bare.intro.as_str(), bare.entries.len()), ("밤", "그냥 글만 있다.", 0));
    }

    #[test]
    fn reads_strings_out_of_json() {
        let json = r#"{"title":"Me at the \"zoo\" 😀 안녕","author_name" : "jawed","width":200}"#;
        assert_eq!(json_string(json, "title").as_deref(), Some("Me at the \"zoo\" 😀 안녕"));
        assert_eq!(json_string(json, "author_name").as_deref(), Some("jawed"));
        assert_eq!(json_string(json, "width"), None);
        assert_eq!(json_string(json, "missing"), None);
    }

    #[test]
    fn writes_times() {
        assert_eq!((clock(0.0), clock(7.9), clock(187.0), clock(3725.0)), ("0:00".into(), "0:07".into(), "3:07".into(), "1:02:05".into()));
    }
}
