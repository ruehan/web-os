//! 음악 목록 파일을 읽는다. 사람이 손으로 고치는 글 파일이다:
//!
//! ```text
//! # 재생 목록의 이름
//! https://youtu.be/영상번호 | 제목 | 아티스트
//! 영상번호
//! // 설명
//! ```
//!
//! 제목과 아티스트를 적지 않은 곡은 유튜브에 물어서(oEmbed) 채운다.

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Track {
    /// 유튜브 영상의 번호
    pub id: String,
    pub title: Option<String>,
    pub artist: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Playlist {
    pub name: String,
    pub tracks: Vec<Track>,
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

/// 목록 파일의 글을 재생 목록들로 읽는다. 알아볼 수 없는 줄은 건너뛴다.
pub fn parse(text: &str) -> Vec<Playlist> {
    let mut lists: Vec<Playlist> = Vec::new();
    for line in text.lines().map(str::trim) {
        if line.is_empty() || line.starts_with("//") {
            continue;
        }
        if let Some(name) = line.strip_prefix('#') {
            lists.push(Playlist { name: name.trim().to_string(), tracks: Vec::new() });
            continue;
        }
        let mut parts = line.split('|').map(str::trim);
        let Some(id) = parts.next().and_then(video_id) else { continue };
        let text = |part: Option<&str>| part.filter(|p| !p.is_empty()).map(str::to_string);
        let track = Track { id, title: text(parts.next()), artist: text(parts.next()) };
        // 이름 줄보다 먼저 나온 곡들은 이름 없는 첫 목록에 담는다.
        if lists.is_empty() {
            lists.push(Playlist { name: "모음".to_string(), tracks: Vec::new() });
        }
        lists.last_mut().expect("just pushed").tracks.push(track);
    }
    lists.retain(|list| !list.tracks.is_empty());
    lists
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
    fn reads_playlists() {
        let lists = parse("// 설명\nfirst000001\n\n# 작업할 때\nhttps://youtu.be/second00002 | 제목 | 아티스트\nthird000003 | 제목만\n알 수 없는 줄\n# 빈 목록\n# 밤에\nfourth00004 |  | 아티스트만");
        assert_eq!(lists.iter().map(|l| (l.name.as_str(), l.tracks.len())).collect::<Vec<_>>(), [("모음", 1), ("작업할 때", 2), ("밤에", 1)]);
        assert_eq!(lists[1].tracks[0], Track { id: "second00002".into(), title: Some("제목".into()), artist: Some("아티스트".into()) });
        assert_eq!(lists[1].tracks[1], Track { id: "third000003".into(), title: Some("제목만".into()), artist: None });
        assert_eq!(lists[2].tracks[0], Track { id: "fourth00004".into(), title: None, artist: Some("아티스트만".into()) });
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
