const fs = require('fs');
const path = require('path');
const { supabase } = require('../config/supabase');

const BUCKET = 'products';

exports.uploadToSupabase = async (file, folder) => {
  if (!file || !file.buffer) {
    throw new Error("File buffer is missing");
  }

  const fileExt = file.originalname.split('.').pop();
  const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
  const filePath = `${folder}/${fileName}`;

  const { data, error } = await supabase.storage
    .from('products')
    .upload(filePath, file.buffer, {
      contentType: file.mimetype,
    });

  if (error) throw error;

  const { data: publicUrl } = supabase
    .storage
    .from('products')
    .getPublicUrl(data.path);

  return {
    url: publicUrl.publicUrl,
    path: data.path,
  };
};