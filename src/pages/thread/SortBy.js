import React, { useState } from 'react'
import {connect, sort, filter, maxCommentsLimit} from '../../state'

const sortBy = props => {
  const [reloadVisible, setReloadVisible] = useState(false)
  let usedMouse;

  return (
  <div id='comment-sort'>
  <label htmlFor='commentSort'>sorted by:</label>
    <span className='space' />
    <select id='commentSort' defaultValue={props.global.state.commentSort}
      onMouseDown={() => usedMouse = true}
      onKeyDown=  {() => usedMouse = false}
      onChange=   {e  => {props.global.setCommentSort(e.target.value); if (usedMouse) e.target.blur()}}>
      <option value={sort.top}>top</option>
      <option value={sort.bottom}>bottom</option>
      <option value={sort.new}>new</option>
      <option value={sort.old}>old</option>
    </select>
    <span className='space' />
  <label htmlFor='commentFilter'>show:</label>
    <span className='space' />
    <select id='commentFilter' defaultValue={props.global.state.commentFilter}
      onMouseDown={() => usedMouse = true}
      onKeyDown=  {() => usedMouse = false}
      onChange=   {e  => {props.global.setCommentFilter(e.target.value); if (usedMouse) e.target.blur()}}>
      <option value={filter.all}>All comments</option>
      <option value={filter.removedDeleted}>Removed and deleted</option>
      <option value={filter.removed}>Removed</option>
      <option value={filter.deleted}>Deleted</option>
    </select>
    <span className='space' />
  <label htmlFor='maxComments'>max. to download:</label>
    <span className='space' />
    <input id='maxComments' onChange={e => {
      if (parseInt(e.target.value) > props.global.state.maxComments && props.global.state.maxComments < maxCommentsLimit)
        setReloadVisible(true)
    }} onBlur={e => {
      e.target.value = props.global.setMaxComments(e.target.value)
    }} defaultValue={props.global.state.maxComments} type='number' maxLength='5' required min='100' max={maxCommentsLimit} step='100' />
  {reloadVisible && <>
    <span className='space' />
    <input onClick={() => location.replace(location.href)} type='button' value='Reload' />
  </>}
  </div>
  )
}

export default connect(sortBy)
