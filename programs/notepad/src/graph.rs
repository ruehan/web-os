//! 메모를 점으로, 링크를 선으로 본 그래프: 만들기와 자리 잡기.

use webos::markdown::{is_image_name, without_code};
use crate::vault::{base_of, kind_of, parse_links, resolve_link, stem_of, Kind};
use std::collections::{HashMap, HashSet};

#[derive(Clone, PartialEq, Debug)]
pub struct Node {
    /// 메모의 경로. 아직 없는 메모는 "?이름"
    pub id: String,
    pub label: String,
    /// 실제로 있는 메모인가 (없는 메모를 가리키는 링크도 점으로 그린다)
    pub exists: bool,
    /// 이어진 선의 수
    pub degree: usize,
    pub x: f32,
    pub y: f32,
}

#[derive(Clone, PartialEq, Debug, Default)]
pub struct Graph {
    pub nodes: Vec<Node>,
    /// 선: 양 끝 점의 순번
    pub links: Vec<(usize, usize)>,
}

/// 메모들(경로, 글)과 그 사이의 링크로 그래프를 만든다. 자리(x, y)는 아직 정하지 않는다.
pub fn build(notes: &[(&str, &str)], files: &[String]) -> Graph {
    let mut nodes: Vec<Node> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut add = |nodes: &mut Vec<Node>, id: String, label: &str, exists: bool| {
        *index.entry(id.clone()).or_insert_with(|| {
            nodes.push(Node { id, label: label.to_string(), exists, degree: 0, x: 0.0, y: 0.0 });
            nodes.len() - 1
        })
    };
    for (path, _) in notes {
        add(&mut nodes, path.to_string(), stem_of(path), true);
    }
    let mut seen = HashSet::new();
    let mut links = Vec::new();
    for (path, text) in notes {
        let from = add(&mut nodes, path.to_string(), stem_of(path), true);
        for link in parse_links(&without_code(text)) {
            let found = resolve_link(&link.target, files);
            // 그림을 넣은 것은 메모 사이의 관계가 아니다.
            if found.is_some_and(|found| kind_of(found) != Kind::Note) || (found.is_none() && link.embed && is_image_name(&link.target)) {
                continue;
            }
            let to = match found {
                Some(found) => add(&mut nodes, found.to_string(), stem_of(found), true),
                None => add(&mut nodes, format!("?{}", base_of(&link.target).to_lowercase()), base_of(&link.target), false),
            };
            if to != from && seen.insert((from, to)) {
                links.push((from, to));
            }
        }
    }
    for &(a, b) in &links {
        nodes[a].degree += 1;
        nodes[b].degree += 1;
    }
    Graph { nodes, links }
}

/// 점들의 자리를 정한다: 서로 밀어내고, 이어진 점끼리는 당기고, 전체를 가운데로 모은다.
/// 같은 입력에는 늘 같은 그림이 나오도록 무작위를 쓰지 않는다 (처음 자리는 원 위에 고르게 놓는다).
pub fn layout(graph: &mut Graph, width: f32, height: f32) {
    const ITERATIONS: usize = 300;
    let count = graph.nodes.len();
    for (i, node) in graph.nodes.iter_mut().enumerate() {
        let angle = i as f32 / count.max(1) as f32 * std::f32::consts::TAU;
        let radius = width.min(height) * 0.35;
        (node.x, node.y) = (width / 2.0 + angle.cos() * radius, height / 2.0 + angle.sin() * radius);
    }
    // 점 사이의 알맞은 거리. 넓은 화면에서도 가장자리까지 퍼지지 않도록 위를 막는다.
    let ideal = (((width * height) / count.max(1) as f32).sqrt() * 0.5).min(150.0);
    for step in 0..ITERATIONS {
        // 뒤로 갈수록 덜 움직여 자리를 잡는다.
        let heat = (1.0 - step as f32 / ITERATIONS as f32) * ideal * 0.15;
        let mut push = vec![(0f32, 0f32); count];
        for a in 0..count {
            for b in a + 1..count {
                let mut dx = graph.nodes[a].x - graph.nodes[b].x;
                let mut dy = graph.nodes[a].y - graph.nodes[b].y;
                if dx == 0.0 {
                    dx = 0.01 * (a as f32 - b as f32);
                }
                if dy == 0.0 {
                    dy = 0.01;
                }
                let dist = dx.hypot(dy);
                let force = ideal * ideal / dist;
                push[a].0 += dx / dist * force;
                push[a].1 += dy / dist * force;
                push[b].0 -= dx / dist * force;
                push[b].1 -= dy / dist * force;
            }
        }
        for &(a, b) in &graph.links {
            let dx = graph.nodes[a].x - graph.nodes[b].x;
            let dy = graph.nodes[a].y - graph.nodes[b].y;
            let dist = dx.hypot(dy).max(0.01);
            let force = dist * dist / ideal;
            push[a].0 -= dx / dist * force;
            push[a].1 -= dy / dist * force;
            push[b].0 += dx / dist * force;
            push[b].1 += dy / dist * force;
        }
        for (node, push) in graph.nodes.iter_mut().zip(&mut push) {
            // 가운데로 살짝 당겨서, 이어지지 않은 점들이 멀리 날아가지 않게 한다.
            push.0 += (width / 2.0 - node.x) * 0.006 * ideal;
            push.1 += (height / 2.0 - node.y) * 0.006 * ideal;
            let size = push.0.hypot(push.1).max(f32::MIN_POSITIVE);
            node.x += push.0 / size * size.min(heat);
            node.y += push.1 / size * size.min(heat);
            // 이름표와 아래 안내문이 들어갈 자리를 남긴다.
            node.x = node.x.max(40.0).min((width - 40.0).max(40.0));
            node.y = node.y.max(24.0).min((height - 56.0).max(24.0));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_nodes_and_links() {
        let files: Vec<String> = ["가.md", "나.md", "그림.png"].iter().map(|s| s.to_string()).collect();
        let notes = [("가.md", "[[나]] [[나]] [[없음]] ![[그림.png]] `[[코드]]` [[가]]"), ("나.md", "[[가]]")];
        let graph = build(&notes, &files);
        let ids: Vec<&str> = graph.nodes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, ["가.md", "나.md", "?없음"]);
        assert_eq!(graph.links, [(0, 1), (0, 2), (1, 0)]);
        assert_eq!(graph.nodes.iter().map(|n| (n.exists, n.degree)).collect::<Vec<_>>(), [(true, 3), (true, 2), (false, 1)]);
    }

    #[test]
    fn lays_out_inside_the_box_the_same_way_every_time() {
        let files: Vec<String> = (0..12).map(|i| format!("{i}.md")).collect();
        let texts: Vec<String> = (0..12).map(|i| format!("[[{}]]", (i + 1) % 12)).collect();
        let notes: Vec<(&str, &str)> = files.iter().map(String::as_str).zip(texts.iter().map(String::as_str)).collect();
        let mut a = build(&notes, &files);
        let mut b = a.clone();
        layout(&mut a, 600.0, 400.0);
        layout(&mut b, 600.0, 400.0);
        assert_eq!(a, b);
        assert!(a.nodes.iter().all(|n| (40.0..=560.0).contains(&n.x) && (24.0..=344.0).contains(&n.y)));
        // 겹치는 점이 없다.
        for (i, m) in a.nodes.iter().enumerate() {
            for n in &a.nodes[i + 1..] {
                assert!((m.x - n.x).hypot(m.y - n.y) > 10.0);
            }
        }
    }
}
