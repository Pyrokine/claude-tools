use crate::config::Config;
use crate::types::*;
use crate::utils::*;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;

/// Get 参数
pub struct GetParams {
    pub r#ref: String,
    pub range: Option<(usize, usize)>,
    pub output: Option<PathBuf>,
    pub project: Option<String>,
}

/// 获取完整内容
pub fn get(config: &Config, params: GetParams) -> Result<GetResponse, ErrorResponse> {
    // 解析 ref
    let parsed_ref = ParsedRef::parse(&params.r#ref).ok_or_else(|| ErrorResponse {
        error: "ref_invalid".to_string(),
        message: format!("无效的 ref 格式: {}，应为 session前8位:行号", params.r#ref),
        available: None,
    })?;

    // 查找 session 文件
    let (project_id, session_id, path) = find_session_file(config, &parsed_ref.session_prefix, params.project.as_deref())?;

    // 读取指定行
    let file = File::open(&path).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("无法打开文件: {}", e),
        available: None,
    })?;

    let reader = BufReader::new(file);
    let mut target_line = None;

    for (line_num, line) in reader.lines().enumerate() {
        if line_num + 1 == parsed_ref.line {
            target_line = Some(line.map_err(|e| ErrorResponse {
                error: "io_error".to_string(),
                message: format!("读取行失败: {}", e),
                available: None,
            })?);
            break;
        }
    }

    let line = target_line.ok_or_else(|| ErrorResponse {
        error: "ref_not_found".to_string(),
        message: format!("ref 不存在: {}", params.r#ref),
        available: None,
    })?;

    // 解析消息
    let record: MessageRecord = serde_json::from_str(&line).map_err(|e| ErrorResponse {
        error: "parse_error".to_string(),
        message: format!("解析消息失败: {}", e),
        available: None,
    })?;

    // 提取内容和图片
    let content = replace_images_with_placeholders(&record);
    let images = extract_images(&record);
    let image_count = images.len();
    let content_size = content.len();

    // 如果指定了 output，写入文件
    if let Some(output_dir) = params.output {
        return write_output(config, &output_dir, &params.r#ref, &record, &content, image_count);
    }

    // 如果指定了 range，返回部分内容
    if let Some((start, end)) = params.range {
        let end = end.min(content.len());
        let start = start.min(end);
        let partial_content = content.chars().skip(start).take(end - start).collect();
        return Ok(GetResponse::Success {
            r#ref: params.r#ref,
            r#type: record.msg_type,
            content: partial_content,
            content_size,
            image_count,
        });
    }

    // 检查内容大小
    const MAX_DIRECT_SIZE: usize = 100_000; // 100KB
    if content_size > MAX_DIRECT_SIZE {
        return Ok(GetResponse::TooLarge {
            error: "content_too_large".to_string(),
            r#ref: params.r#ref,
            size: content_size,
            suggestion: format!(
                "使用 --output 导出到文件，或用 --range 0-{} 分块获取",
                MAX_DIRECT_SIZE
            ),
        });
    }

    Ok(GetResponse::Success {
        r#ref: params.r#ref,
        r#type: record.msg_type,
        content,
        content_size,
        image_count,
    })
}

/// 查找 session 文件
pub fn find_session_file(
    config: &Config,
    session_prefix: &str,
    project_id: Option<&str>,
) -> Result<(String, String, PathBuf), ErrorResponse> {
    // 确定要搜索的项目
    let project_dirs: Vec<(String, PathBuf)> = if let Some(pid) = project_id {
        let dir = config.project_dir(pid);
        if !dir.exists() {
            return Err(ErrorResponse {
                error: "project_not_found".to_string(),
                message: format!("项目不存在: {}", pid),
                available: None,
            });
        }
        vec![(pid.to_string(), dir)]
    } else if let Some(pid) = config.current_project_id() {
        vec![(pid.clone(), config.project_dir(&pid))]
    } else {
        // 搜索所有项目
        let mut dirs = Vec::new();
        if let Ok(entries) = fs::read_dir(&config.projects_dir) {
            for entry in entries.flatten() {
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    let id = entry.file_name().to_string_lossy().to_string();
                    dirs.push((id, entry.path()));
                }
            }
        }
        dirs
    };

    // 在项目中查找匹配的 session
    for (project_id, dir) in project_dirs {
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.extension().map(|e| e == "jsonl").unwrap_or(false) {
                    continue;
                }

                let filename = entry.file_name().to_string_lossy().to_string();
                if let Some(session_id) = session_id_from_filename(&filename) {
                    if ref_prefix(&session_id) == session_prefix {
                        return Ok((project_id, session_id, path));
                    }
                }
            }
        }
    }

    Err(ErrorResponse {
        error: "session_not_found".to_string(),
        message: format!("找不到 session: {}", session_prefix),
        available: None,
    })
}

/// 写入输出文件
fn write_output(
    config: &Config,
    output_dir: &PathBuf,
    r#ref: &str,
    record: &MessageRecord,
    content: &str,
    image_count: usize,
) -> Result<GetResponse, ErrorResponse> {
    // 创建输出目录
    fs::create_dir_all(output_dir).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("无法创建输出目录: {}", e),
        available: None,
    })?;

    let safe_ref = r#ref.replace(':', "_");

    // 写入内容文件
    let content_path = output_dir.join(format!("{}.txt", safe_ref));
    let mut file = File::create(&content_path).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("无法创建文件: {}", e),
        available: None,
    })?;
    file.write_all(content.as_bytes()).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("写入文件失败: {}", e),
        available: None,
    })?;

    // 导出图片
    let mut image_paths = Vec::new();
    let images = extract_images(record);
    for img in &images {
        if let Some((ext, data)) = extract_image_data(record, img.index) {
            let img_path = output_dir.join(format!("{}_img{}.{}", safe_ref, img.index, ext));
            if let Ok(mut img_file) = File::create(&img_path) {
                if img_file.write_all(&data).is_ok() {
                    image_paths.push(img_path);
                }
            }
        }
    }

    Ok(GetResponse::Output {
        r#ref: r#ref.to_string(),
        output: OutputInfo {
            content: content_path,
            images: image_paths,
        },
        content_size: content.len(),
        image_count,
    })
}
